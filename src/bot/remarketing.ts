import { logger } from '../utils/logger';
import { db } from '../data/connection';
import { sessions, stores } from '../data/schema';
import { eq, and, lte, gte, lt, sql } from 'drizzle-orm';
import { getMemory, saveMemory, countRemarketingLast24h } from '../data/database';
import { getAllProducts } from '../data/catalog';
import { canSendProactive, pruneHealthEvents } from './health';
import OpenAI from 'openai';
import { config } from '../config/env';

const CRON_INTERVAL_MS = 10 * 60 * 1000;

// Modelos en cascada: si el primero se queda sin cuota, seguimos con el siguiente
// en vez de perder el seguimiento en silencio.
const REMARKETING_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.1-flash-lite-preview'];

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Hora local (0-23) en la zona horaria configurada. */
function localHour(): number {
    try {
        return Number(new Intl.DateTimeFormat('en-US', {
            timeZone: config.REMARKETING_TIMEZONE,
            hour: 'numeric',
            hour12: false
        }).format(new Date()));
    } catch {
        return new Date().getHours();
    }
}

/** Nadie quiere publicidad a las 3 de la mañana: eso genera reportes, y los reportes generan baneos. */
function isWithinSendingHours(): boolean {
    const hour = localHour();
    return hour >= config.REMARKETING_START_HOUR && hour < config.REMARKETING_END_HOUR;
}

async function generateRemarketingMessage(
    storeId: string,
    systemPrompt: string,
    apiKey: string,
    history: OpenAI.Chat.ChatCompletionMessageParam[]
): Promise<string> {
    const products = await getAllProducts(storeId);
    const catalogLines = products.map(p => {
        const price = p.price != null ? `$${p.price}` : 'consultar precio';
        const url = p.checkoutUrl ? ` | Link: ${p.checkoutUrl}` : '';
        return `- ${p.name} — ${price}${url}`;
    }).join('\n');

    const remarketingInstruction = `Eres un asistente de ventas. El cliente con quien estuviste hablando no ha vuelto a escribir en varias horas.
Tu tarea es escribir UN SOLO mensaje de seguimiento natural, personalizado y persuasivo para recuperar su interés.
El mensaje debe:
- Basarse en el contexto de la conversación anterior (qué preguntó, qué le interesó)
- Adaptarse al tipo de producto/servicio que vende la tienda (infoproducto, físico, servicio, etc.)
- Sonar humano y cercano, NO genérico ni de plantilla
- Incluir una llamada a la acción clara
- Ser breve (máximo 3-4 líneas)
NO menciones envíos físicos ni despachos si son productos digitales.

Información de la tienda:
${systemPrompt}

${catalogLines ? `Catálogo:\n${catalogLines}` : ''}

Escribe ÚNICAMENTE el mensaje, sin explicaciones ni comillas.`;

    const openai = new OpenAI({
        apiKey,
        baseURL: config.OPENAI_BASE_URL || undefined
    });

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: remarketingInstruction },
        ...history.filter(m => m.role === 'user' || (m.role === 'assistant' && typeof m.content === 'string')).slice(-6)
    ];

    let lastError: any;
    for (const model of REMARKETING_MODELS) {
        try {
            const response = await openai.chat.completions.create({ model, messages });
            return response.choices[0].message.content || '';
        } catch (err: any) {
            lastError = err;
            logger.warn(`Remarketing: ${model} falló (${err.status ?? err.message}), probando siguiente...`);
        }
    }
    throw lastError;
}

/**
 * Registra la última vez que el usuario nos escribió y reabre la ventana de seguimiento.
 * El tope de por vida (remarketingCount) NO se reinicia aquí a propósito: si no,
 * el mismo contacto recibiría seguimientos para siempre.
 */
export async function recordUserActivity(sessionId: string) {
    try {
        await db.update(sessions)
            .set({
                lastMessageAt: new Date(),
                remarketingSent: false
            })
            .where(eq(sessions.sessionId, sessionId));
    } catch (error: any) {
        logger.error(`Error actualizando actividad para ${sessionId}: ${error.message}`);
    }
}

let tickRunning = false;

async function runRemarketingTick(sendFunc: (storeId: string, to: string, msg: string) => Promise<void>) {
    if (tickRunning) {
        logger.warn('⏰ El ciclo anterior de remarketing sigue corriendo; se salta este tick.');
        return;
    }
    tickRunning = true;

    try {
        void pruneHealthEvents();

        if (!isWithinSendingHours()) return;

        const now = Date.now();
        const silentSince = new Date(now - config.REMARKETING_MIN_HOURS * 60 * 60 * 1000);
        const notOlderThan = new Date(now - config.REMARKETING_MAX_HOURS * 60 * 60 * 1000);

        const pendingSessions = await db.query.sessions.findMany({
            where: and(
                eq(sessions.remarketingSent, false),
                eq(sessions.optedOut, false),
                lte(sessions.lastMessageAt, silentSince),
                gte(sessions.lastMessageAt, notOlderThan),
                lt(sessions.remarketingCount, config.REMARKETING_MAX_PER_CONTACT)
            ),
            limit: config.REMARKETING_BATCH_SIZE * 5
        });

        if (pendingSessions.length === 0) return;

        let sentThisTick = 0;
        const storeUsage = new Map<string, number>();

        for (const record of pendingSessions) {
            if (sentThisTick >= config.REMARKETING_BATCH_SIZE) {
                logger.info(`⏰ Tope del tick alcanzado (${config.REMARKETING_BATCH_SIZE}); el resto sigue en el próximo ciclo.`);
                break;
            }

            try {
                // Este canal solo envía por WhatsApp. Telegram usa su propio transporte.
                if (record.sessionId.includes('_tg_')) continue;

                // Usamos las columnas reales, no parseamos el sessionId.
                const storeId = record.storeId;
                const phone = (record.phone || '').replace(/[^0-9]/g, '');
                if (!storeId || !/^\d{7,15}$/.test(phone)) {
                    logger.warn(`Remarketing omitido: teléfono inválido en ${record.sessionId}`);
                    continue;
                }

                const store = await db.query.stores.findFirst({ where: eq(stores.id, storeId) });
                if (!store || !store.isActive) continue;

                // Si la salud del número se está deteriorando, lo primero que se
                // apaga es el saliente proactivo. Responder sigue permitido.
                const salud = await canSendProactive(storeId);
                if (!salud.allowed) {
                    logger.warn(`🩺 [${storeId}] Remarketing suspendido por ${salud.reason}.`);
                    storeUsage.set(storeId, Number.MAX_SAFE_INTEGER);
                    continue;
                }

                // Tope diario por tienda (se consulta a la BD, sobrevive reinicios).
                let used = storeUsage.get(storeId);
                if (used === undefined) {
                    used = await countRemarketingLast24h(storeId);
                    storeUsage.set(storeId, used);
                }
                if (used >= config.REMARKETING_MAX_PER_STORE_DAY) {
                    logger.warn(`🛑 [${storeId}] Tope diario de remarketing alcanzado (${used}). No se envía más hoy.`);
                    continue;
                }

                const history = await getMemory(record.sessionId) || [];
                const apiKey = store.openaiApiKey || config.OPENAI_API_KEY;

                let msg: string;
                try {
                    msg = await generateRemarketingMessage(storeId, store.systemPrompt, apiKey, history);
                } catch (aiError: any) {
                    logger.error(`Error generando mensaje de remarketing: ${aiError.message}`);
                    continue;
                }
                if (!msg.trim()) continue;

                // El opt-out va siempre, no depende de que la IA se acuerde de ponerlo.
                const finalMsg = `${msg.trim()}\n\n${config.REMARKETING_OPTOUT_TEXT}`;

                logger.info(`🔥 Remarketing → ${phone} (tienda ${storeId}, intento ${(record.remarketingCount || 0) + 1}/${config.REMARKETING_MAX_PER_CONTACT})`);
                await sendFunc(storeId, phone, finalMsg);

                history.push({ role: 'assistant', content: finalMsg });
                await saveMemory(record.sessionId, storeId, phone, history);

                await db.update(sessions)
                    .set({
                        remarketingSent: true,
                        remarketingCount: sql`COALESCE(${sessions.remarketingCount}, 0) + 1`,
                        lastRemarketingAt: new Date()
                    })
                    .where(eq(sessions.sessionId, record.sessionId));

                storeUsage.set(storeId, used + 1);
                sentThisTick++;

                // Ritmo humano entre envíos: las ráfagas son la firma que dispara baneos.
                const gap = config.REMARKETING_MIN_DELAY_MS +
                    Math.floor(Math.random() * Math.max(1, config.REMARKETING_MAX_DELAY_MS - config.REMARKETING_MIN_DELAY_MS));
                await sleep(gap);

            } catch (error: any) {
                logger.error(`Error enviando remarketing a ${record.sessionId}: ${error.message}`);
            }
        }

        if (sentThisTick > 0) {
            logger.info(`⏰ Ciclo de remarketing terminado: ${sentThisTick} mensaje(s) enviado(s).`);
        }
    } catch (dbError: any) {
        logger.error(`Error en cron de remarketing: ${dbError.message}`);
    } finally {
        tickRunning = false;
    }
}

export function startRemarketingCron(sendFunc: (storeId: string, to: string, msg: string) => Promise<void>) {
    if (!config.REMARKETING_ENABLED) {
        logger.warn('⏰ Motor de Remarketing DESACTIVADO por configuración (REMARKETING_ENABLED=false).');
        return;
    }

    logger.info(
        `⏰ Motor de Remarketing INICIADO — ventana ${config.REMARKETING_MIN_HOURS}h-${config.REMARKETING_MAX_HOURS}h, ` +
        `horario ${config.REMARKETING_START_HOUR}:00-${config.REMARKETING_END_HOUR}:00 (${config.REMARKETING_TIMEZONE}), ` +
        `máx ${config.REMARKETING_MAX_PER_CONTACT}/contacto y ${config.REMARKETING_MAX_PER_STORE_DAY}/tienda al día.`
    );

    setInterval(() => { void runRemarketingTick(sendFunc); }, CRON_INTERVAL_MS);
}
