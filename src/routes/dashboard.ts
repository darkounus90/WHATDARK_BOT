import { Router, Request, Response } from 'express';
import { getAllSessions, deleteSession } from '../data/database';
import { getAllProducts, createProduct, updateProduct, deleteProduct } from '../data/catalog';
import { db } from '../data/connection';
import { stores } from '../data/schema';
import { eq } from 'drizzle-orm';
import path from 'path';
import { getBotStatus, startBotInstance, stopBotInstance, sendWhatsAppMessage, pauseChat } from '../channels/whatsapp';
import axios from 'axios';
import OpenAI from 'openai';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { users } from '../data/schema';
import crypto from 'crypto';

export const dashboardRouter = Router();

// Middleware de roles
const isSuperAdmin = (req: any) => req.user?.role === 'superadmin' || req.user?.user === config.DASHBOARD_USER;
const checkSuperAdmin = (req: any, res: Response, next: any) => {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Prohibido: Solo superadmin' });
    next();
};

// ============ GESTIÓN DE USUARIOS (Superadmin) ============
dashboardRouter.get('/api/users', checkSuperAdmin, async (req: Request, res: Response) => {
    try {
        const allUsers = await db.select({
            id: users.id,
            username: users.username,
            role: users.role,
            storeId: users.storeId,
            createdAt: users.createdAt
        }).from(users);
        res.json(allUsers);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

dashboardRouter.post('/api/users', checkSuperAdmin, async (req: Request, res: Response) => {
    try {
        const { username, password, storeId, role } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña obligatorios' });
        
        const hashedPass = crypto.createHash('sha256').update(password).digest('hex');
        
        const newUser = await db.insert(users).values({
            id: Date.now().toString(),
            username,
            passwordHash: hashedPass,
            storeId: storeId || null,
            role: role || 'store_owner'
        }).returning();
        
        res.status(201).json({ id: newUser[0].id, username: newUser[0].username, role: newUser[0].role });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

dashboardRouter.delete('/api/users/:id', checkSuperAdmin, async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        await db.delete(users).where(eq(users.id, id));
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// ============ GESTIÓN DE TIENDAS / BOTS ============

// Listar tiendas
dashboardRouter.get('/api/stores', async (req: any, res: Response) => {
    try {
        if (isSuperAdmin(req)) {
            const allStores = await db.query.stores.findMany();
            res.json(allStores);
        } else {
            const store = await db.query.stores.findMany({ where: eq(stores.id, req.user.storeId) });
            res.json(store);
        }
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Crear una nueva tienda (Añadir Bot)
dashboardRouter.post('/api/stores', checkSuperAdmin, async (req: Request, res: Response) => {
    try {
        const { id, name, systemPrompt, openaiApiKey, pqrEmail, telegramToken, telegramBotActive } = req.body;
        if (!id || !name) {
            return res.status(400).json({ error: 'ID y Nombre son obligatorios' });
        }

        const newStore = await db.insert(stores).values({
            id,
            name,
            systemPrompt: systemPrompt || "Eres un asistente de ventas experto.",
            openaiApiKey: openaiApiKey || null,
            pqrEmail: pqrEmail || null,
            telegramToken: telegramToken || null,
            telegramBotActive: !!telegramBotActive,
            isActive: true
        }).returning();

        res.status(201).json(newStore[0]);
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// Eliminar una tienda (Borrar Bot)
dashboardRouter.delete('/api/stores/:id', checkSuperAdmin, async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        
        // Primero apagamos el bot si está corriendo
        await stopBotInstance(id);
        
        // Luego borramos de la BD
        await db.delete(stores).where(eq(stores.id, id));
        
        res.json({ success: true, message: `Tienda ${id} eliminada correctamente` });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Actualizar configuración de una tienda (Bot)
dashboardRouter.put('/api/stores/:id', async (req: any, res: Response) => {
    try {
        const id = req.params.id as string;
        if (!isSuperAdmin(req) && req.user.storeId !== id) {
            return res.status(403).json({ error: 'No tienes permiso para modificar esta tienda' });
        }

        const { name, systemPrompt, openaiApiKey, isActive, whatsappPhoneNumberId, whatsappAccessToken, pqrEmail, telegramToken, telegramBotActive } = req.body;

        if (!name) return res.status(400).json({ error: 'El nombre es obligatorio' });
        if (!systemPrompt) return res.status(400).json({ error: 'El System Prompt es obligatorio' });

        const updated = await db.update(stores)
            .set({
                name,
                systemPrompt,
                openaiApiKey: openaiApiKey || null,
                pqrEmail: pqrEmail || null,
                telegramToken: telegramToken || null,
                telegramBotActive: !!telegramBotActive,
                isActive,
                ...(whatsappPhoneNumberId !== undefined && { whatsappPhoneNumberId: whatsappPhoneNumberId || null }),
                ...(whatsappAccessToken !== undefined && { whatsappAccessToken: whatsappAccessToken || null }),
            })
            .where(eq(stores.id, id))
            .returning();

        if (updated.length === 0) {
            return res.status(404).json({ error: 'Tienda no encontrada' });
        }

        res.json(updated[0]);
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// Obtener estado y QR de un bot
dashboardRouter.get('/api/bots/status/:storeId', (req: any, res: Response) => {
    const storeId = req.params.storeId as string;
    if (!isSuperAdmin(req) && req.user.storeId !== storeId) return res.status(403).json({ error: 'Prohibido' });
    const status = getBotStatus(storeId);
    res.json(status);
});

// Iniciar un bot manualmente
dashboardRouter.post('/api/bots/start/:storeId', async (req: any, res: Response) => {
    const storeId = req.params.storeId as string;
    if (!isSuperAdmin(req) && req.user.storeId !== storeId) return res.status(403).json({ error: 'Prohibido' });
    // Ejecutar en segundo plano para no congelar el Dashboard
    startBotInstance(storeId).catch(err => logger.error(`Error iniciando bot ${storeId}: ${err.message}`));
    res.json({ success: true, message: `Iniciando bot para ${storeId}` });
});

// ============ SESIONES / CHATS ============
dashboardRouter.get('/api/sessions', async (req: any, res: Response) => {
    const storeId = isSuperAdmin(req) ? req.query.storeId as string | undefined : req.user.storeId;
    if (!storeId && !isSuperAdmin(req)) return res.status(400).json({ error: 'storeId es obligatorio' });
    const sessions = await getAllSessions(storeId);
    res.json(sessions);
});

dashboardRouter.delete('/api/sessions/:sessionId', async (req: any, res: Response) => {
    try {
        const sessionId = req.params.sessionId as string;
        await deleteSession(sessionId);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// ============ PRODUCTOS (CRUD) ============
// Listar todos los productos
dashboardRouter.get('/api/products', async (req: any, res: Response) => {
    const storeId = isSuperAdmin(req) ? req.query.storeId as string | undefined : req.user.storeId;
    if (!storeId && !isSuperAdmin(req)) return res.status(400).json({ error: 'storeId es obligatorio' });
    const products = await getAllProducts(storeId);
    
    // Mapear schema DB a JSON que espera el Frontend
    const mappedProducts = products.map(p => ({
        id: p.id,
        storeId: p.storeId,
        nombre: p.name,
        descripcion_corta: p.description?.substring(0, 50) || '',
        descripcion_larga: p.description,
        categoria: p.productType,
        precio: p.price,
        imagen_url: p.imageUrl,
        link: p.checkoutUrl,
        stock: 100, // No está en la BD actualmente
        activo: true // No está en la BD actualmente
    }));
    
    res.json(mappedProducts);
});

// Crear un producto nuevo
dashboardRouter.post('/api/products', async (req: any, res: Response) => {
    try {
        const storeId = isSuperAdmin(req) ? req.body.storeId : req.user.storeId;
        if (!storeId) {
            return res.status(400).json({ error: 'El storeId es obligatorio' });
        }
        
        // Mapear desde JSON Frontend a schema DB
        const productData = {
            name: req.body.nombre,
            description: req.body.descripcion_larga || req.body.descripcion_corta,
            productType: req.body.categoria || 'physical',
            price: req.body.precio,
            imageUrl: req.body.imagen_url,
            checkoutUrl: req.body.link
        };

        const product = await createProduct(productData, storeId);
        res.status(201).json(product);
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// Actualizar un producto
dashboardRouter.put('/api/products/:id', async (req: any, res: Response) => {
    try {
        const id = req.params.id as string;
        const storeId = isSuperAdmin(req) ? req.body.storeId : req.user.storeId;
        if (!storeId) {
            return res.status(400).json({ error: 'El storeId es obligatorio' });
        }

        // Mapear desde JSON Frontend a schema DB
        const productData = {
            name: req.body.nombre,
            description: req.body.descripcion_larga || req.body.descripcion_corta,
            productType: req.body.categoria,
            price: req.body.precio,
            imageUrl: req.body.imagen_url,
            checkoutUrl: req.body.link
        };

        const updated = await updateProduct(id, productData, storeId);
        if (!updated) {
            res.status(404).json({ error: 'Producto no encontrado o no pertenece a tu tienda' });
            return;
        }
        res.json(updated);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Eliminar un producto
dashboardRouter.delete('/api/products/:id', async (req: any, res: Response) => {
    try {
        const id = req.params.id as string;
        const storeId = isSuperAdmin(req) ? (req.body.storeId || req.query.storeId) as string : req.user.storeId;
        if (!storeId) {
            return res.status(400).json({ error: 'El storeId es obligatorio' });
        }
        const deleted = await deleteProduct(id, storeId);
        if (!deleted) {
            res.status(404).json({ error: 'Producto no encontrado' });
            return;
        }
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Endpoint para extraer info de producto con IA
dashboardRouter.post('/api/products/extract', async (req: Request, res: Response) => {
    try {
        const { url } = req.body;
        if (!url) {
            res.status(400).json({ error: 'Falta la URL' });
            return;
        }

        // --- PROTECCIÓN SSRF: Validar URL y resolver DNS ---
        try {
            const parsedUrl = new URL(url);
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                return res.status(400).json({ error: 'Protocolo no permitido' });
            }
            
            // Resolver DNS manualmente
            const dns = require('dns').promises;
            const lookup = await dns.lookup(parsedUrl.hostname);
            const ip = lookup.address;
            
            // Expresión regular para detectar IPs privadas, loopback, link-local, etc.
            const isPrivateIP = /(^127\.)|(^10\.)|(^172\.1[6-9]\.)|(^172\.2[0-9]\.)|(^172\.3[0-1]\.)|(^192\.168\.)|(^169\.254\.)/.test(ip);
            
            if (isPrivateIP || ip === '0.0.0.0' || parsedUrl.hostname.endsWith('.internal')) {
                return res.status(400).json({ error: 'URL no permitida por seguridad (SSRF)' });
            }
        } catch (e) {
            return res.status(400).json({ error: 'URL inválida o dominio inaccesible' });
        }
        // ------------------------------------

        let response;
        try {
            response = await axios.get(url, { 
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 10000, // Timeout de 10s
                maxRedirects: 0 // NO seguir redirecciones para evitar Bypass SSRF
            });
        } catch (axiosError: any) {
            if (axiosError.response && [301, 302, 307, 308].includes(axiosError.response.status)) {
                throw new Error('La URL intentó redirigir, lo cual está bloqueado por seguridad.');
            }
            throw new Error(`No se pudo acceder a la URL: ${axiosError.message}`);
        }

        const rawHtml = response.data.toString();
        // Limpiar el HTML para quitar scripts, estilos, svgs y dejar mayormente texto
        const cleanHtml = rawHtml
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
            .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
            .replace(/<[^>]+>/g, ' ') // Quitar el resto de etiquetas HTML
            .replace(/\s+/g, ' ') // Reducir espacios
            .trim()
            .substring(0, 15000); // Tomar los primeros 15k caracteres de texto puro

        const openai = new OpenAI({
            apiKey: config.OPENAI_API_KEY,
            baseURL: config.OPENAI_BASE_URL || undefined
        });

        const prompt = `Analiza el siguiente texto extraído de una página web y extrae la información del producto, curso o servicio que se ofrece.
ESTO ES CRÍTICO: DEBES DEVOLVER ÚNICA Y EXCLUSIVAMENTE UN OBJETO JSON VÁLIDO.
NUNCA inventes productos (ej. no inventes "Aceites para cabello" si el texto habla de "Recetas" o viceversa). Si la página vende un curso o un reto, extrae eso.
Si no encuentras información útil, deja los campos en blanco, pero NO alucines.
Tu respuesta debe empezar con '{' y terminar con '}'.
Usa las siguientes llaves estrictamente:
{
  "nombre": "Nombre del producto o servicio real",
  "precio": "Precio en número si aparece (solo el valor, sin símbolos)",
  "categoria": "Categoría sugerida basada en el contenido real",
  "descripcion_corta": "Un resumen real de 1 línea",
  "descripcion_larga": "Descripción detallada real de lo que se ofrece",
  "imagen": "URL de la imagen principal si la encuentras, o vacio",
  "system_prompt_sugerido": "Escribe un prompt de sistema conciso (máximo 400 caracteres) para que un bot de WhatsApp venda este producto con el tono de la página."
}

Texto a analizar:
${cleanHtml}`;

        let aiResponse;
        try {
            const aiParams: any = {
                model: config.OPENAI_MODEL,
                messages: [
                    { role: 'system', content: 'You are an API that strictly returns raw JSON objects. Never include conversational text, lists, or markdown. Your output must start with { and end with }.' },
                    { role: 'user', content: prompt }
                ]
            };
            
            // Si el modelo lo soporta (OpenAI nativo o Ollama reciente), fuerza el formato JSON
            if (config.OPENAI_MODEL.includes('gpt') || config.OPENAI_MODEL.includes('llama') || config.OPENAI_MODEL.includes('phi')) {
                 aiParams.response_format = { type: "json_object" };
            }

            aiResponse = await openai.chat.completions.create(aiParams);
        } catch (aiError: any) {
            logger.error('Error llamando a la IA:', aiError);
            const msg: string = aiError.message || '';
            if (msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('too many requests') || msg.toLowerCase().includes('quota')) {
                throw new Error('Límite de cuota de IA alcanzado. Por favor, intenta de nuevo en unos minutos.');
            }
            throw new Error(`Error en la IA (${config.OPENAI_MODEL}): ${msg}. Revisa si Ollama/OpenAI están activos.`);
        }

        const rawContent = aiResponse.choices[0].message.content || '';
        
        // Si el contenido indica error de cuota o está vacío
        if (!rawContent || rawContent.includes('Demasiadas solicitudes') || rawContent.includes('Too many requests')) {
            throw new Error('Límite de cuota de IA alcanzado. Por favor, intenta de nuevo en unos minutos.');
        }

        // Limpiar posibles bloques de código markdown
        let jsonText = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();

        // Intentar extraer solo el objeto JSON si hay texto adicional
        try {
            const firstBrace = jsonText.indexOf('{');
            const lastBrace = jsonText.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) {
                jsonText = jsonText.substring(firstBrace, lastBrace + 1);
            }

            const data = JSON.parse(jsonText);
            res.json(data);
        } catch (parseError: any) {
            logger.error('Error parseando JSON de IA:', jsonText);
            throw new Error('La IA no devolvió un formato válido. Contenido recibido: ' + rawContent.substring(0, 100) + '...');
        }
    } catch (error: any) {
        logger.error('Error en /api/products/extract:', error);
        res.status(500).json({ error: error.message.startsWith('Error extrayendo') ? error.message : 'Error extrayendo con IA: ' + error.message });
    }
});

// Endpoint para que un humano responda desde el panel
dashboardRouter.post('/api/reply', async (req: any, res: Response) => {
    try {
        const { sessionId, message, phone } = req.body;
        const storeId = isSuperAdmin(req) ? req.body.storeId : req.user.storeId;

        if (!phone || !message || !storeId) {
            res.status(400).json({ error: 'Falta teléfono, mensaje o storeId' });
            return;
        }
        
        if (sessionId) {
            pauseChat(sessionId);
        }
        
        await sendWhatsAppMessage(storeId, phone, message);
        res.json({ success: true, botPaused: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

dashboardRouter.get('/api/test-models', checkSuperAdmin, async (req: Request, res: Response) => {
    const models = [
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-2.5-pro',
        'gemma-3-27b-it',
        'gemma-3-4b-it',
    ];
    const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY, baseURL: config.OPENAI_BASE_URL || undefined });
    const results: Record<string, string> = {};

    for (const model of models) {
        try {
            const r = await openai.chat.completions.create({
                model,
                messages: [{ role: 'user', content: 'Di solo: OK' }],
                max_tokens: 5
            } as any);
            results[model] = `✅ ${r.choices[0].message.content?.trim()}`;
        } catch (err: any) {
            results[model] = `❌ ${err.status ?? ''} ${err.message?.substring(0, 60)}`;
        }
    }

    res.json(results);
});

dashboardRouter.get('/', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '../../public/dashboard.html'));
});

