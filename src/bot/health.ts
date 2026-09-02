import crypto from 'crypto';
import { db } from '../data/connection';
import { healthEvents, sessions } from '../data/schema';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { config } from '../config/env';

/**
 * Monitor de salud del número.
 *
 * whatsapp-web.js no da calificación de calidad: el baneo llega sin aviso.
 * Esto reconstruye una aproximación con las señales observables desde adentro,
 * y frena el bot solo cuando se deterioran.
 *
 * Degradación en dos escalones, a propósito:
 *   - Responder a quien te escribió es lo más seguro que hace el bot.
 *   - Lo que arriesga es el saliente proactivo.
 * Por eso una señal mala mata primero el remarketing, y solo los fallos de
 * entrega —que ya indican bloqueos— apagan todo el saliente.
 */

export type HealthEventType = 'inbound' | 'outbound' | 'send_failed' | 'opt_out';
export type HealthStatus = 'ok' | 'watch' | 'degraded' | 'critical';

export interface HealthSignal {
    key: string;
    label: string;
    value: number;
    threshold: number;
    breached: boolean;
    detail: string;
}

export interface StoreHealth {
    storeId: string;
    status: HealthStatus;
    pauseProactive: boolean;
    pauseAll: boolean;
    signals: HealthSignal[];
    counts: {
        inbound24h: number;
        outbound24h: number;
        sendFailed24h: number;
        optOut7d: number;
        contacts7d: number;
        proactiveSent7d: number;
        proactiveReplied7d: number;
    };
    checkedAt: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; health: StoreHealth }>();

/**
 * Registra una señal. Nunca lanza ni bloquea: la salud del monitor jamás debe
 * tumbar la conversación que está midiendo.
 */
export function recordHealthEvent(storeId: string, type: HealthEventType, sessionId?: string): void {
    if (!config.HEALTH_ENABLED || !storeId) return;

    db.insert(healthEvents)
        .values({ id: crypto.randomUUID(), storeId, type, sessionId: sessionId || null })
        .catch((error: any) => logger.error(`Health: no se pudo registrar ${type}: ${error.message}`));
}

async function countsByType(storeId: string, since: Date): Promise<Record<string, number>> {
    const rows = await db.select({
        type: healthEvents.type,
        n: sql<number>`count(*)::int`
    })
        .from(healthEvents)
        .where(and(eq(healthEvents.storeId, storeId), gte(healthEvents.createdAt, since)))
        .groupBy(healthEvents.type);

    const out: Record<string, number> = {};
    for (const row of rows) out[row.type] = Number(row.n);
    return out;
}

async function countSessions(where: any): Promise<number> {
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(sessions).where(where);
    return Number(rows[0]?.n ?? 0);
}

function rate(part: number, whole: number): number {
    if (whole <= 0) return 0;
    return part / whole;
}

export interface HealthCounts {
    inbound24h: number;
    outbound24h: number;
    sendFailed24h: number;
    optOut7d: number;
    contacts7d: number;
    proactiveSent7d: number;
    proactiveReplied7d: number;
}

/**
 * Evaluación pura: de contadores a diagnóstico. Sin BD, para poder probarla.
 * Los mínimos por señal existen porque un porcentaje sobre 3 mensajes no dice nada.
 */
export function evaluateHealth(storeId: string, c: HealthCounts): StoreHealth {
    const signals: HealthSignal[] = [];

    // 1. Fallos de entrega — la señal más dura.
    const failureRate = rate(c.sendFailed24h, c.outbound24h);
    signals.push({
        key: 'failure_rate',
        label: 'Fallos de entrega (24 h)',
        value: Number(failureRate.toFixed(3)),
        threshold: config.HEALTH_MAX_FAILURE_RATE,
        breached: c.outbound24h >= 20 && failureRate > config.HEALTH_MAX_FAILURE_RATE,
        detail: `${c.sendFailed24h} fallidos de ${c.outbound24h} envíos`
    });

    // 2. Cuánta gente pide que no le escribas más.
    const optOutRate = rate(c.optOut7d, c.contacts7d);
    signals.push({
        key: 'optout_rate',
        label: 'Tasa de opt-out (7 días)',
        value: Number(optOutRate.toFixed(3)),
        threshold: config.HEALTH_MAX_OPTOUT_RATE,
        breached: c.contacts7d >= 10 && optOutRate > config.HEALTH_MAX_OPTOUT_RATE,
        detail: `${c.optOut7d} STOP de ${c.contacts7d} contactos`
    });

    // 3. ¿El bot conversa o predica?
    const outboundRatio = c.inbound24h > 0
        ? c.outbound24h / c.inbound24h
        : (c.outbound24h > 0 ? Infinity : 0);
    signals.push({
        key: 'outbound_ratio',
        label: 'Salientes por cada entrante (24 h)',
        value: Number.isFinite(outboundRatio) ? Number(outboundRatio.toFixed(2)) : 999,
        threshold: config.HEALTH_MAX_OUTBOUND_RATIO,
        breached: c.outbound24h >= 50 && outboundRatio > config.HEALTH_MAX_OUTBOUND_RATIO,
        detail: `${c.outbound24h} enviados / ${c.inbound24h} recibidos`
    });

    // 4. ¿Los seguimientos le interesan a alguien?
    const replyRate = rate(c.proactiveReplied7d, c.proactiveSent7d);
    signals.push({
        key: 'proactive_reply_rate',
        label: 'Respuesta a seguimientos (7 días)',
        value: Number(replyRate.toFixed(3)),
        threshold: config.HEALTH_MIN_PROACTIVE_REPLY_RATE,
        breached: c.proactiveSent7d >= 20 && replyRate < config.HEALTH_MIN_PROACTIVE_REPLY_RATE,
        detail: `${c.proactiveReplied7d} respondieron de ${c.proactiveSent7d} seguimientos`
    });

    const failureBreached = signals.find(s => s.key === 'failure_rate')!.breached;
    const otherBreaches = signals.filter(s => s.key !== 'failure_rate' && s.breached).length;

    let status: HealthStatus = 'ok';
    if (failureBreached) status = 'critical';
    else if (otherBreaches >= 2) status = 'degraded';
    else if (otherBreaches === 1) status = 'watch';

    return {
        storeId,
        status,
        // Cualquier señal mala frena el saliente proactivo.
        pauseProactive: failureBreached || otherBreaches >= 1,
        // Solo los fallos de entrega apagan todo: responder sigue siendo seguro.
        pauseAll: failureBreached,
        signals,
        counts: c,
        checkedAt: new Date().toISOString()
    };
}

export async function getStoreHealth(storeId: string): Promise<StoreHealth> {
    const now = Date.now();
    const since24h = new Date(now - 24 * 60 * 60 * 1000);
    const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const events24h = await countsByType(storeId, since24h);
    const events7d = await countsByType(storeId, since7d);

    const inbound24h = events24h.inbound || 0;
    const outbound24h = events24h.outbound || 0;
    const sendFailed24h = events24h.send_failed || 0;
    const optOut7d = events7d.opt_out || 0;

    // Contactos activos y efectividad de los seguimientos, leídos de las sesiones.
    const contacts7d = await countSessions(
        and(eq(sessions.storeId, storeId), gte(sessions.updatedAt, since7d))
    );
    const proactiveSent7d = await countSessions(
        and(eq(sessions.storeId, storeId), gte(sessions.lastRemarketingAt, since7d))
    );
    // Respondió = volvió a escribir después de que le mandamos el seguimiento.
    const proactiveReplied7d = await countSessions(
        and(
            eq(sessions.storeId, storeId),
            gte(sessions.lastRemarketingAt, since7d),
            sql`${sessions.lastMessageAt} > ${sessions.lastRemarketingAt}`
        )
    );

    return evaluateHealth(storeId, {
        inbound24h, outbound24h, sendFailed24h,
        optOut7d, contacts7d, proactiveSent7d, proactiveReplied7d
    });
}

/** Versión cacheada, para poder consultarla en caliente sin castigar la BD. */
export async function getStoreHealthCached(storeId: string): Promise<StoreHealth | null> {
    const hit = cache.get(storeId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.health;

    try {
        const health = await getStoreHealth(storeId);
        cache.set(storeId, { at: Date.now(), health });

        if (health.status !== 'ok') {
            const rotas = health.signals.filter(s => s.breached).map(s => `${s.label}: ${s.detail}`);
            logger.warn(`🩺 [${storeId}] Salud del número: ${health.status.toUpperCase()} — ${rotas.join(' | ')}`);
        }
        return health;
    } catch (error: any) {
        logger.error(`Health: no se pudo evaluar ${storeId}: ${error.message}`);
        return null;
    }
}

/**
 * ¿Se puede mandar saliente proactivo ahora mismo?
 * Ante un fallo del monitor devolvemos true: el monitor no debe dejar la
 * operación muerta por un problema suyo.
 */
export async function canSendProactive(storeId: string): Promise<{ allowed: boolean; reason?: string }> {
    if (!config.HEALTH_ENABLED) return { allowed: true };

    const health = await getStoreHealthCached(storeId);
    if (!health) return { allowed: true };

    if (health.pauseProactive) {
        const rotas = health.signals.filter(s => s.breached).map(s => s.label).join(', ');
        return { allowed: false, reason: `salud ${health.status} (${rotas})` };
    }
    return { allowed: true };
}

/** Borra bitácora vieja. Se llama desde el cron de remarketing. */
let lastPruneAt = 0;

export async function pruneHealthEvents(): Promise<void> {
    if (!config.HEALTH_ENABLED) return;
    // Como máximo una vez por hora: el cron corre cada 10 minutos.
    if (Date.now() - lastPruneAt < 60 * 60 * 1000) return;
    lastPruneAt = Date.now();
    try {
        const cutoff = new Date(Date.now() - config.HEALTH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
        await db.delete(healthEvents).where(lt(healthEvents.createdAt, cutoff));
    } catch (error: any) {
        logger.error(`Health: no se pudo limpiar la bitácora: ${error.message}`);
    }
}
