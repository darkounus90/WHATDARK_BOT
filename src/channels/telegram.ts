import TelegramBot from 'node-telegram-bot-api';
import { handleUserMessage } from '../bot/agent';
import { takePendingImages } from '../bot/tools';
import { logger } from '../utils/logger';
import { stores } from '../data/schema';
import { eq } from 'drizzle-orm';
import { db } from '../data/connection';
import { getSession, setSessionPause, setOptOut, checkRateLimit, incrementMessageCount } from '../data/database';
import { isOptOutRequest } from '../utils/optout';

const telegramBots = new Map<string, TelegramBot>();

// Cola de mensajes POR SESIÓN: encadena los mensajes de un mismo chat para que
// dos mensajes seguidos del mismo usuario no se procesen en paralelo y se pisen
// el historial. A diferencia de whatsapp.ts, aquí sí borramos la entrada cuando
// la cola de esa sesión queda vacía (ver releaseQueue): dejarla crecer para
// siempre es la fuga de memoria que arrastra el canal de WhatsApp.
const messageQueues = new Map<string, Promise<void>>();

// Límite diario de mensajes por sesión (control de gasto de la API de OpenAI).
const DAILY_MESSAGE_LIMIT = 50;

/**
 * Inicializa todos los bots de Telegram que tengan token configurado
 */
export async function initializeTelegramClients() {
    try {
        const allStores = await db.query.stores.findMany({
            where: eq(stores.telegramBotActive, true)
        });

        if (allStores.length === 0) return;

        logger.info(`🚀 Iniciando ${allStores.length} instancias de Telegram...`);
        for (const s of allStores) {
            if (s.telegramToken) {
                await initTelegramBot(s.id, s.telegramToken);
            }
        }
    } catch (error) {
        logger.error('❌ Error inicializando Telegram:', error);
    }
}

export async function initTelegramBot(storeId: string, token: string) {
    if (telegramBots.has(storeId)) {
        telegramBots.get(storeId)?.stopPolling();
    }

    const bot = new TelegramBot(token, { polling: true });
    telegramBots.set(storeId, bot);

    logger.info(`✈️ [${storeId}] Bot de Telegram iniciado.`);

    bot.on('message', async (msg) => {
        try {
            if (!msg.text || msg.from?.is_bot) return;

            const chatId = msg.chat.id.toString();
            const sessionId = `${storeId}_tg_${chatId}`;
            const userText = msg.text;

            logger.info(`✈️ [${storeId}] Mensaje de Telegram (${chatId}): ${userText}`);

            // HANDOVER: !bot devuelve el control al bot, igual que en WhatsApp.
            // Va antes que cualquier otra comprobación porque es la única forma
            // que tiene el usuario de salir del estado pausado.
            if (userText.trim().toLowerCase() === '!bot') {
                await setSessionPause(sessionId, false);
                await bot.sendMessage(chatId, 'Bot reactivado correctamente. ¿En qué te puedo ayudar?');
                return;
            }

            // OPT-OUT: se atiende incluso con el chat pausado; es un derecho del cliente.
            if (isOptOutRequest(userText)) {
                await setOptOut(sessionId, true);
                await bot.sendMessage(chatId, 'Listo, no te vuelvo a escribir. Si algún día necesitas algo, aquí estoy 🙏');
                logger.info(`🚫 [${storeId}] ${chatId} (Telegram) pidió no recibir más mensajes.`);
                return;
            }

            // PAUSA / HANDOVER HUMANO: si alguien pausó la sesión, el bot calla.
            const currentSession = await getSession(sessionId);
            if (currentSession?.isPaused) return;

            // CONTROL DE GASTO: rate limit diario por sesión.
            const limit = await checkRateLimit(sessionId, DAILY_MESSAGE_LIMIT);
            if (!limit.allowed) {
                await bot.sendMessage(chatId, 'Has alcanzado el límite de mensajes por hoy. Podrás seguir chateando mañana. ¡Gracias!');
                return;
            }

            // Encolamos detrás de lo que ya esté corriendo para esta sesión.
            const previousQueue = messageQueues.get(sessionId) || Promise.resolve();

            const nextQueue: Promise<void> = previousQueue
                .then(async () => {
                    // Re-verificamos la pausa: el mensaje pudo esperar en la cola
                    // mientras un humano tomaba el chat.
                    const sessionCheck = await getSession(sessionId);
                    if (sessionCheck?.isPaused) return;

                    const store = await db.query.stores.findFirst({ where: eq(stores.id, storeId) });
                    if (!store) return;

                    const response = await handleUserMessage(
                        sessionId,
                        storeId,
                        chatId,
                        userText,
                        store.systemPrompt,
                        store.openaiApiKey || null
                    );

                    if (response) {
                        await bot.sendMessage(chatId, response);
                    }

                    // Vaciar siempre la cola: si no, las fotos quedarían colgadas en memoria.
                    for (const image of takePendingImages(sessionId)) {
                        try {
                            await bot.sendPhoto(chatId, Buffer.from(image.base64, 'base64'), { caption: image.caption });
                        } catch (mediaError: any) {
                            logger.error(`❌ [${storeId}] Error enviando foto por Telegram: ${mediaError.message}`);
                        }
                    }

                    await incrementMessageCount(sessionId);
                })
                // El catch va ANTES del finally y dentro de la cadena: así un
                // mensaje que falla no rompe la cola de los siguientes.
                .catch((err: any) => {
                    logger.error(`❌ [${storeId}] Error en cola de Telegram (${sessionId}): ${err?.message || err}`);
                })
                .finally(() => {
                    // Solo el ÚLTIMO eslabón limpia el Map. Si mientras tanto llegó
                    // otro mensaje, messageQueues ya apunta a una promesa distinta y
                    // no debemos borrarla; así la entrada desaparece cuando la sesión
                    // queda inactiva y el Map no crece sin control.
                    if (messageQueues.get(sessionId) === nextQueue) {
                        messageQueues.delete(sessionId);
                    }
                });

            messageQueues.set(sessionId, nextQueue);

        } catch (error) {
            logger.error(`❌ [${storeId}] Error en Telegram:`, error);
        }
    });

    bot.on('polling_error', (error) => {
        logger.error(`⚠️ [${storeId}] Error de polling en Telegram:`, error);
    });
}

export function stopTelegramBot(storeId: string) {
    const bot = telegramBots.get(storeId);
    if (bot) {
        bot.stopPolling();
        telegramBots.delete(storeId);
        logger.info(`✈️ [${storeId}] Bot de Telegram detenido.`);
    }
}
