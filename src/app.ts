import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import { config } from './config/env';
import { hashPassword, verifyPassword, isLegacyHash, safeEquals } from './utils/password';
import { logger } from './utils/logger';
import { initializeWhatsAppClient, sendWhatsAppMessage, stopBotInstance } from './channels/whatsapp';
import { initializeTelegramClients, stopTelegramBot } from './channels/telegram';
import { startRemarketingCron } from './bot/remarketing';
import { dashboardRouter } from './routes/dashboard';
import path from 'path';
import { db } from './data/connection';
import { users, stores } from './data/schema';
import { eq } from 'drizzle-orm';

function bootstrap() {
    logger.info(`Iniciando AI Bot para Ecommerce: ${config.STORE_NAME}`);
    
    const app = express();

    // Cuántos proxies hay delante. Sin esto, detrás de ngrok o un reverse proxy
    // todas las peticiones parecen venir de la misma IP y el rate limit del
    // login castigaría a todo el mundo por igual.
    app.set('trust proxy', config.TRUST_PROXY);
    
    // 1. Seguridad Básica (Headers)
    app.use(helmet({
        contentSecurityPolicy: false,
    }));

    app.use(express.json());
    app.use(cookieParser());
    app.use(cors());

    // 2. Limitación de Peticiones
    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 3000, // Aumentado porque el dashboard hace polling cada 5 segundos
        message: { error: 'Demasiadas peticiones desde esta IP' }
    });
    app.use('/dashboard/api', limiter);

    // El limiter de arriba solo cubre /dashboard/api: el login quedaba
    // completamente abierto a fuerza bruta. Este lo cierra.
    const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 10,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        message: { error: 'Demasiados intentos fallidos. Espera unos minutos.' }
    });

    const cookieOptions = {
        httpOnly: true as const,
        sameSite: 'lax' as const,
        secure: config.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000
    };

    // --- SISTEMA DE AUTENTICACIÓN POR COOKIE/JWT ---
    
    // Middleware de protección
    const authMiddleware = (req: any, res: any, next: any) => {
        const token = req.cookies.auth_token;
        
        const isApiRequest = req.originalUrl.includes('/api/') || req.xhr;

        if (!token) {
            if (isApiRequest) {
                return res.status(401).json({ error: 'Sesión expirada o inválida' });
            }
            return res.redirect('/login.html');
        }

        try {
            const decoded = jwt.verify(token, config.JWT_SECRET) as any;
            req.user = decoded;
            next();
        } catch (err) {
            res.clearCookie('auth_token');
            if (isApiRequest) {
                return res.status(401).json({ error: 'Sesión expirada' });
            }
            return res.redirect('/login.html');
        }
    };

    // Ruta de Login
    app.post('/api/auth/login', loginLimiter, async (req, res) => {
        const { username, password } = req.body || {};
        if (!username || !password) {
            return res.status(400).json({ error: 'Faltan credenciales' });
        }

        try {
            // Superadmin definido en el .env
            if (safeEquals(username, config.DASHBOARD_USER) && safeEquals(password, config.DASHBOARD_PASSWORD)) {
                const token = jwt.sign({ user: username, role: 'superadmin', storeId: null }, config.JWT_SECRET, { expiresIn: '24h' });
                res.cookie('auth_token', token, cookieOptions);
                return res.json({ success: true });
            }

            const user = await db.query.users.findFirst({
                where: eq(users.username, username)
            });

            // verifyPattern acepta scrypt y, de forma transitoria, el SHA-256
            // viejo. Lo que NO acepta es una contraseña en texto plano, que es
            // lo que hacía la versión anterior con `user.passwordHash === password`.
            if (user && verifyPassword(password, user.passwordHash)) {

                // Migración transparente: el primer login con hash viejo lo reescribe.
                if (isLegacyHash(user.passwordHash)) {
                    try {
                        await db.update(users)
                            .set({ passwordHash: hashPassword(password) })
                            .where(eq(users.id, user.id));
                        logger.info(`🔐 Contraseña de ${user.username} migrada a scrypt.`);
                    } catch (migrationError) {
                        logger.error('No se pudo migrar el hash de contraseña:', migrationError);
                    }
                }

                const token = jwt.sign({
                    user: user.username,
                    role: user.role,
                    storeId: user.storeId
                }, config.JWT_SECRET, { expiresIn: '24h' });

                res.cookie('auth_token', token, cookieOptions);
                return res.json({ success: true });
            }
        } catch (e) {
            logger.error('Error en el login:', e);
        }

        logger.warn(`🔒 Login fallido para "${String(username).slice(0, 40)}"`);
        res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    });

    // Ruta de Logout
    app.post('/api/auth/logout', (req, res) => {
        res.clearCookie('auth_token');
        res.json({ success: true });
    });

    // Archivos estáticos públicos (CSS, Login, etc)
    app.use(express.static(path.join(__dirname, '../public')));

    // Rutear el panel de control con protección JWT
    app.use('/dashboard', authMiddleware, dashboardRouter);

    app.listen(config.PORT, () => {
        logger.info(`🌍 Panel de control escuchando en el puerto ${config.PORT}`);
        logger.info(`Accede al panel en: http://localhost:${config.PORT}/dashboard`);
    });

    // INICIAR EL CLIENTE DE WHATSAPP WEB (CÓDIGO QR)
    initializeWhatsAppClient();
    initializeTelegramClients();

    // INICIAR EL MOTOR DE REMARKETING (Carritos abandonados)
    startRemarketingCron((storeId, to, msg) => sendWhatsAppMessage(storeId, to, msg));

    // Manejar cierres inesperados (Graceful Shutdown)
    const shutdown = async (code: number = 0) => {
        logger.info('🛑 Cerrando el bot...');
        
        try {
            const allStores = await db.query.stores.findMany({ where: eq(stores.isActive, true) });
            for (const s of allStores) {
                await stopBotInstance(s.id);
                stopTelegramBot(s.id);
            }
            // NOTA: drizzle no expone un end() global en node-postgres,
            // pero cerramos los bots para limpiar Puppeteer.
            logger.info('✅ Todos los navegadores de WhatsApp cerrados correctamente.');
        } catch (error) {
            logger.error('Error durante el cierre:', error);
        }

        // Salir con 0 tras un error fatal hacía que PM2 y systemd lo tomaran
        // por un apagado voluntario y NO reiniciaran el proceso.
        process.exit(code);
    };

    process.on('SIGINT', () => shutdown(0));
    process.on('SIGTERM', () => shutdown(0));
    
    // Capturar errores fatales para no dejar navegadores zombies
    process.on('uncaughtException', async (err) => {
        logger.error('💥 Error Fatal no capturado:', err);
        await shutdown(1);
    });
    process.on('unhandledRejection', async (reason, promise) => {
        logger.error('💥 Promesa rechazada no capturada:', reason);
        // Algunos errores de Puppeteer (Execution context) son promesas rechazadas
        // Si es un error crítico de Puppeteer, cerramos todo de forma segura
        if (reason && reason.toString().includes('Execution context was destroyed')) {
            logger.error('Reiniciando bots por error de Puppeteer...');
            await shutdown(1);
        }
    });
}

bootstrap();
