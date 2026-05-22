import { Router, Request, Response } from 'express';
import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { logger } from '../utils/logger';
import { config } from '../config/env';
import { handleUserMessage } from '../bot/agent';
import { recordUserActivity } from '../bot/remarketing';
import { db } from '../data/connection';
import { stores } from '../data/schema';
import { eq } from 'drizzle-orm';
import { getSession, setSessionPause, checkRateLimit, incrementMessageCount } from '../data/database';

export const whatsappRouter = Router();

// Gestión Multi-Instancia
const clients = new Map<string, Client>();
const qrCodes = new Map<string, string>();
const clientStatus = new Map<string, 'DISCONNECTED' | 'CONNECTING' | 'QR_READY' | 'CONNECTED'>();
const messageQueues = new Map<string, Promise<void>>();

/**
 * Inicializa todos los bots que estén activos en la base de datos
 */
export async function initializeWhatsAppClient() {
    try {
        const allStores = await db.query.stores.findMany({
            where: eq(stores.isActive, true)
        });

        logger.info(`🚀 Iniciando ${allStores.length} instancias de WhatsApp...`);

        for (const store of allStores) {
            try {
                await startBotInstance(store.id);
            } catch (err: any) {
                logger.error(`❌ No se pudo iniciar el bot [${store.id}]: ${err.message}`);
            }
        }
    } catch (error: any) {
        logger.error(`Error inicializando clientes: ${error.message}`);
    }
}

/**
 * Arranca una instancia específica de WhatsApp
 */
export async function startBotInstance(storeId: string) {
    if (clients.has(storeId)) {
        logger.warn(`El bot para la tienda ${storeId} ya está en ejecución o iniciado.`);
        return;
    }

    logger.info(`🛠️ Arrancando instancia para tienda: ${storeId}`);
    clientStatus.set(storeId, 'CONNECTING');

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: storeId }),
        puppeteer: {
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote'
            ]
        }
    });

    client.on('qr', (qr) => {
        qrCodes.set(storeId, qr);
        clientStatus.set(storeId, 'QR_READY');
        logger.info(`📲 [${storeId}] Nuevo QR generado. Entra al Dashboard para escanearlo.`);
    });

    client.on('ready', () => {
        qrCodes.delete(storeId);
        clientStatus.set(storeId, 'CONNECTED');
        logger.info(`✅ [${storeId}] Cliente está LISTO.`);
    });

    client.on('authenticated', () => {
        logger.info(`🔐 [${storeId}] Autenticado correctamente.`);
    });

    client.on('auth_failure', (msg) => {
        clientStatus.set(storeId, 'DISCONNECTED');
        logger.error(`❌ [${storeId}] Fallo de autenticación: ${msg}`);
    });

    client.on('disconnected', (reason) => {
        clientStatus.set(storeId, 'DISCONNECTED');
        clients.delete(storeId);
        logger.warn(`🔌 [${storeId}] Cliente desconectado: ${reason}`);
    });

    client.on('message', async (message) => {
        try {
            if (message.isStatus || (await message.getChat()).isGroup || message.from.includes('@broadcast')) return;

            // Obtener el número real del contacto (los LIDs @lid no son teléfonos reales)
            let senderPhone = message.from.replace(/@.*$/, '');
            const isLid = message.from.includes('@lid');
            
            if (isLid) {
                try {
                    const contact = await message.getContact();
                    // contact.id.user tiene el número real (ej: "573219813212")
                    const idUser = (contact as any)?.id?.user;
                    if (idUser && /^\d{7,15}$/.test(idUser)) {
                        senderPhone = idUser;
                    } else {
                        // Fallback: getFormattedNumber
                        try {
                            const formatted = await (contact as any).getFormattedNumber();
                            if (formatted) senderPhone = formatted.replace(/[^0-9]/g, '');
                        } catch(e) {}
                    }
                } catch (e: any) {
                    logger.error(`📱 Error resolviendo LID ${message.from}: ${e.message}`);
                }
                logger.info(`📱 [${storeId}] LID: ${message.from} → Resuelto: ${senderPhone}`);
            }
            
            const userText = message.body;
            const sessionId = `${storeId}_${senderPhone}`;

            // Handover Humano
            if (userText.trim().toLowerCase() === '!bot') {
                await resumeChat(sessionId);
                await client.sendMessage(message.from, "Bot reactivado correctamente. ¿En qué te puedo ayudar?");
                return;
            }

            const currentSession = await getSession(sessionId);
            if (currentSession?.isPaused) return;

            // CONTROL DE GASTO: Rate Limit
            const limit = await checkRateLimit(sessionId, 50); // 50 mensajes por día
            if (!limit.allowed) {
                await client.sendMessage(message.from, "Has alcanzado el límite de mensajes por hoy. Podrás seguir chateando mañana. ¡Gracias!");
                return;
            }

            // Encolar mensajes para evitar colisiones
            const currentQueue = messageQueues.get(sessionId) || Promise.resolve();
            const nextQueue = currentQueue.then(async () => {
                const sessionCheck = await getSession(sessionId);
                if (sessionCheck?.isPaused) return;

                // Humanización: Delay
                const typingDelay = Math.floor(Math.random() * 3000) + 2000;
                await new Promise(resolve => setTimeout(resolve, typingDelay));

                // Obtener config de esta tienda específica
                const store = await db.query.stores.findFirst({
                    where: eq(stores.id, storeId)
                });

                const defaultPrompt = `Eres Santi, asesor de la tienda. Tu objetivo es vender de forma MUY natural por WhatsApp, como un humano real.
REGLAS ESTRICTAS:
1. NUNCA suenes como un robot o call center (nada de "¡Excelente! Me encanta escuchar eso" o "¡Claro que sí!").
2. Respuestas CORTAS, máximo 2 o 3 líneas. Ve al grano.
3. Usa máximo 1 emoji por mensaje, o a veces ninguno.
4. Habla coloquial, fresco, como si le escribieras a un amigo ("Súper", "Dale", "Mira, te cuento...").
5. GARANTÍA: Todos los productos están en Hotmart, así que SIEMPRE tienen 7 días de garantía de satisfacción o se devuelve el dinero. Úsalo como cierre de venta.
6. Si te piden algo, búscalo en el catálogo. Si no hay exacto, recomienda algo similar de una vez sin dar tantos rodeos.
7. PQR y Soporte: Si un cliente tiene una Petición, Queja o Reclamo, dale SIEMPRE este correo de soporte: ${store?.pqrEmail || 'soporte@tienda.com'} y dile que le responderán súper rápido.
8. Cierra la venta con preguntas simples ("¿Te paso el link?", "¿Te animas con este?").
9. PAGO: Si el cliente pregunta cómo pagar, pide ayuda con el pago, o tiene problemas para pagar, NO expliques el proceso paso a paso. Usa el tool generate_payment_link y envía ÚNICAMENTE este aviso fijo: "⚠️ Aviso importante sobre el pago: El proceso de pago se realiza en nuestra plataforma segura. Haz clic en el enlace y sigue las instrucciones que aparecen en pantalla. Por tu seguridad, NUNCA compartas los datos de tu tarjeta por este chat. Si tienes problemas con el pago, contáctanos por este mismo medio y te ayudaremos. 🔒"`;

                const aiResponse = await handleUserMessage(
                    sessionId,
                    storeId,
                    senderPhone,
                    userText,
                    store?.systemPrompt?.trim() ? store.systemPrompt : defaultPrompt,
                    (store?.openaiApiKey?.trim() || config.OPENAI_API_KEY) || "",
                    undefined
                );

                await client.sendMessage(message.from, aiResponse);
                await incrementMessageCount(sessionId);
                await recordUserActivity(sessionId);
            }).catch(err => logger.error(`Error en cola [${storeId}]: ${err.message}`));

            messageQueues.set(sessionId, nextQueue);

        } catch (error: any) {
            logger.error(`Error procesando mensaje en [${storeId}]: ${error.message}`);
        }
    });

    clients.set(storeId, client);
    
    try {
        await client.initialize();
    } catch (err: any) {
        if (err.message.includes('Execution context was destroyed') || err.message.includes('Session closed')) {
            logger.warn(`⚠️ [${storeId}] El bot se detuvo durante el inicio.`);
        } else {
            logger.error(`❌ Error inicializando bot [${storeId}]: ${err.message}`);
        }
        clients.delete(storeId);
    }
}

/**
 * Funciones de utilidad para el Dashboard
 */
export function getBotStatus(storeId: string) {
    return {
        status: clientStatus.get(storeId) || 'DISCONNECTED',
        qr: qrCodes.get(storeId) || null
    };
}

export async function stopBotInstance(storeId: string) {
    const client = clients.get(storeId);
    if (client) {
        try {
            await client.destroy();
            logger.info(`🛑 Bot [${storeId}] detenido y destruido.`);
        } catch (err: any) {
            logger.error(`Error destruyendo bot [${storeId}]: ${err.message}`);
        }
    }
    clients.delete(storeId);
    qrCodes.delete(storeId);
    clientStatus.delete(storeId);
}

export async function pauseChat(sessionId: string) {
    await setSessionPause(sessionId, true);
}

export async function resumeChat(sessionId: string) {
    await setSessionPause(sessionId, false);
}

export async function sendWhatsAppMessage(storeId: string, to: string, text: string) {
    try {
        const client = clients.get(storeId);
        if (!client) throw new Error(`Cliente no iniciado para la tienda ${storeId}`);

        const chatId = to.includes('@') ? to : `${to}@c.us`;
        try {
            await client.sendMessage(chatId, text);
            logger.info(`✅ Mensaje enviado desde [${storeId}] a ${to}`);
        } catch (sendError: any) {
            if (sendError.message?.includes('LID') && !to.includes('@')) {
                const resolvedId = await (client as any).getNumberId(to);
                if (resolvedId) {
                    await client.sendMessage(resolvedId._serialized, text);
                    logger.info(`✅ Mensaje enviado desde [${storeId}] a ${to} (vía LID resuelto)`);
                } else {
                    throw sendError;
                }
            } else {
                throw sendError;
            }
        }
    } catch (error: any) {
        logger.error(`❌ Error enviando desde [${storeId}]: ${error.message}`);
    }
}

