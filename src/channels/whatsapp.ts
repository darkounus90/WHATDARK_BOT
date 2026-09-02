import { Router, Request, Response } from 'express';
import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { logger } from '../utils/logger';
import { config } from '../config/env';
import { handleUserMessage } from '../bot/agent';
import { takePendingImages, PendingImage } from '../bot/tools';
import { recordHealthEvent } from '../bot/health';
import { recordUserActivity } from '../bot/remarketing';
import { db } from '../data/connection';
import { stores } from '../data/schema';
import { eq } from 'drizzle-orm';
import { getSession, setSessionPause, setOptOut, checkRateLimit, incrementMessageCount } from '../data/database';
import { isOptOutRequest } from '../utils/optout';

export const whatsappRouter = Router();

// Gestión Multi-Instancia
const clients = new Map<string, Client>();
const qrCodes = new Map<string, string>();
const clientStatus = new Map<string, 'DISCONNECTED' | 'CONNECTING' | 'QR_READY' | 'CONNECTED'>();
const messageQueues = new Map<string, Promise<void>>();

// Ventana (en segundos) fuera de la cual un mensaje se considera "fantasma"
// (WhatsApp Web re-sincroniza historial al conectar y dispara eventos de mensajes viejos).
const MAX_MESSAGE_AGE_SECONDS = 30;

// IDs de mensajes que envio el propio bot, para no confundirlos con respuestas manuales del duenio.
const botSentMessageIds = new Set<string>();

function markBotMessage(id?: string | null) {
    if (!id) return;
    botSentMessageIds.add(id);
    if (botSentMessageIds.size > 1000) {
        const oldest = botSentMessageIds.values().next().value;
        if (oldest) botSentMessageIds.delete(oldest);
    }
}

// Envios en vuelo del bot, marcados ANTES de mandar el mensaje: 'message_create'
// puede dispararse antes de que sendMessage() resuelva y su ID este disponible.
const pendingBotSends = new Map<string, { count: number; at: number }>();

function sendKey(chatId: string, text: string): string {
    return `${chatId.replace(/@.*$/, '')}::${(text || '').trim().slice(0, 120)}`;
}

function markPendingBotSend(chatId: string, text: string) {
    const key = sendKey(chatId, text);
    const entry = pendingBotSends.get(key);
    // Contamos, no marcamos: dos fotos sin pie de foto en el mismo chat
    // comparten clave, y con un booleano la segunda parecería del duenio.
    pendingBotSends.set(key, { count: (entry?.count || 0) + 1, at: Date.now() });

    const cutoff = Date.now() - 60_000;
    for (const [k, v] of pendingBotSends) {
        if (v.at < cutoff) pendingBotSends.delete(k);
    }
}

function consumePendingBotSend(chatId: string, text: string): boolean {
    const key = sendKey(chatId, text);
    const entry = pendingBotSends.get(key);
    if (!entry || entry.count <= 0) return false;
    if (entry.count === 1) pendingBotSends.delete(key);
    else pendingBotSends.set(key, { count: entry.count - 1, at: entry.at });
    return true;
}

/** Unico punto de salida de mensajes del bot: marca el envio para no auto-pausarse. */
async function botSend(client: Client, storeId: string, chatId: string, text: string) {
    markPendingBotSend(chatId, text);
    try {
        const sent = await client.sendMessage(chatId, text);
        markBotMessage((sent as any)?.id?._serialized);
        recordHealthEvent(storeId, 'outbound');
        return sent;
    } catch (error) {
        // Un envío que falla suele significar que del otro lado te bloquearon.
        // Es la señal más temprana de que el número va camino al baneo.
        recordHealthEvent(storeId, 'send_failed');
        throw error;
    }
}

/** Envía una foto marcándola como propia, para que no dispare el handover. */
async function botSendMedia(client: Client, storeId: string, chatId: string, image: PendingImage) {
    const media = new MessageMedia(image.mimetype, image.base64);
    markPendingBotSend(chatId, image.caption || '');
    try {
        const sent = await client.sendMessage(chatId, media, { caption: image.caption });
        markBotMessage((sent as any)?.id?._serialized);
        recordHealthEvent(storeId, 'outbound');
        return sent;
    } catch (error) {
        recordHealthEvent(storeId, 'send_failed');
        throw error;
    }
}

function messageAgeSeconds(timestamp?: number): number {
    if (!timestamp) return 0;
    return (Date.now() / 1000) - timestamp;
}

/**
 * Un chat puede venir como @lid (identificador anonimo) o como @c.us (telefono real).
 * Devolvemos todos los telefonos candidatos para poder ubicar la sesion guardada.
 */
async function resolveCandidatePhones(client: Client, chatId: string): Promise<string[]> {
    const candidates = new Set<string>();
    const raw = chatId.replace(/@.*$/, '');
    if (raw) candidates.add(raw);

    try {
        const contact: any = await client.getContactById(chatId);
        const idUser = contact?.id?.user;
        if (idUser && /^\d{7,15}$/.test(idUser)) candidates.add(idUser);
        if (contact?.number) candidates.add(String(contact.number).replace(/[^0-9]/g, ''));
        try {
            const formatted = await contact.getFormattedNumber();
            if (formatted) candidates.add(String(formatted).replace(/[^0-9]/g, ''));
        } catch (e) { /* el contacto no expone numero formateado */ }
    } catch (e) { /* contacto no resoluble, nos quedamos con el id crudo */ }

    return [...candidates].filter(Boolean);
}

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

            // ANTI-MENSAJES FANTASMA: al reconectar, WhatsApp Web reenvia historial.
            // Solo atendemos mensajes realmente recientes.
            const age = messageAgeSeconds(message.timestamp);
            if (age > MAX_MESSAGE_AGE_SECONDS) {
                logger.warn(`👻 [${storeId}] Mensaje viejo ignorado (${Math.round(age)}s) de ${message.from}`);
                return;
            }

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

            recordHealthEvent(storeId, 'inbound', sessionId);

            // Handover Humano
            if (userText.trim().toLowerCase() === '!bot') {
                await resumeChat(sessionId);
                await botSend(client, storeId, message.from, "Bot reactivado correctamente. ¿En qué te puedo ayudar?");
                return;
            }

            // OPT-OUT: se atiende incluso con el chat pausado; es un derecho del cliente.
            if (isOptOutRequest(userText)) {
                await setOptOut(sessionId, true);
                recordHealthEvent(storeId, 'opt_out', sessionId);
                await botSend(client, storeId, message.from, "Listo, no te vuelvo a escribir. Si algún día necesitas algo, aquí estoy 🙏");
                logger.info(`🚫 [${storeId}] ${senderPhone} pidió no recibir más mensajes.`);
                return;
            }

            const currentSession = await getSession(sessionId);
            if (currentSession?.isPaused) return;

            // CONTROL DE GASTO: Rate Limit
            const limit = await checkRateLimit(sessionId, 50); // 50 mensajes por día
            if (!limit.allowed) {
                await botSend(client, storeId, message.from, "Has alcanzado el límite de mensajes por hoy. Podrás seguir chateando mañana. ¡Gracias!");
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

                await botSend(client, storeId, message.from, aiResponse);

                // Fotos que la IA decidió mandar durante esta respuesta.
                for (const image of takePendingImages(sessionId)) {
                    try {
                        await botSendMedia(client, storeId, message.from, image);
                    } catch (mediaError: any) {
                        logger.error(`Error enviando foto en [${storeId}]: ${mediaError.message}`);
                    }
                }

                await incrementMessageCount(sessionId);
                await recordUserActivity(sessionId);
            }).catch(err => logger.error(`Error en cola [${storeId}]: ${err.message}`));

            messageQueues.set(sessionId, nextQueue);

        } catch (error: any) {
            logger.error(`Error procesando mensaje en [${storeId}]: ${error.message}`);
        }
    });

    // HANDOVER AUTOMATICO: si el duenio contesta manualmente desde su celular,
    // el bot cede el control y se calla en ese chat.
    client.on('message_create', async (message) => {
        try {
            if (!message.fromMe) return;

            // Si el mensaje lo mandamos nosotros mismos, no es una intervencion humana.
            const outgoingId = (message as any)?.id?._serialized;
            if (outgoingId && botSentMessageIds.has(outgoingId)) return;
            if (consumePendingBotSend(message.to || '', message.body || '')) return;

            const target = message.to || '';
            if (!target || target.includes('@g.us') || target.includes('@broadcast') || message.isStatus) return;

            // No reaccionar al historial re-sincronizado.
            if (messageAgeSeconds(message.timestamp) > MAX_MESSAGE_AGE_SECONDS) return;

            const phones = await resolveCandidatePhones(client, target);
            const body = (message.body || '').trim().toLowerCase();

            for (const phone of phones) {
                const sessionId = `${storeId}_${phone}`;
                const session = await getSession(sessionId);
                if (!session) continue;

                if (body === '!bot') {
                    await resumeChat(sessionId);
                    await botSend(client, storeId, target, "Listo, sigo yo desde aquí 👍");
                    logger.info(`🤖 [${storeId}] Bot reactivado manualmente en el chat con ${phone}.`);
                    return;
                }

                if (!session.isPaused) {
                    await setSessionPause(sessionId, true);
                    logger.info(`🙋 [${storeId}] El duenio respondió a ${phone} — bot pausado en ese chat (escribe !bot para reactivarlo).`);
                }
                return;
            }
        } catch (error: any) {
            logger.error(`Error en handover automático [${storeId}]: ${error.message}`);
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
            await botSend(client, storeId, chatId, text);
            logger.info(`✅ Mensaje enviado desde [${storeId}] a ${to}`);
        } catch (sendError: any) {
            if (sendError.message?.includes('LID') && !to.includes('@')) {
                const resolvedId = await (client as any).getNumberId(to);
                if (resolvedId) {
                    await botSend(client, storeId, resolvedId._serialized, text);
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

