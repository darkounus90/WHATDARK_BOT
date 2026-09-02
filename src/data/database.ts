import { db } from './connection';
import { sessions, stores, products } from './schema';
import { eq, desc, and, gte, sql } from 'drizzle-orm';
import { logger } from '../utils/logger';
import OpenAI from 'openai';

// IMPORTANTE: Ahora la base de datos es Multi-Tenant (PostgreSQL).
// getMemory y saveMemory ahora requieren el storeId para la arquitectura SaaS.

export async function getSession(sessionId: string) {
    try {
        return await db.query.sessions.findFirst({
            where: eq(sessions.sessionId, sessionId)
        });
    } catch (error: any) {
        logger.error(`Error obteniendo sesión ${sessionId}: ${error.message}`);
        return null;
    }
}

export async function getMemory(sessionId: string): Promise<OpenAI.Chat.ChatCompletionMessageParam[] | null> {
    try {
        const row = await getSession(sessionId);
        
        if (row && row.historyJson) {
            return (typeof row.historyJson === 'string' ? JSON.parse(row.historyJson) : row.historyJson) as OpenAI.Chat.ChatCompletionMessageParam[];
        }
        return null;
    } catch (error: any) {
        logger.error(`Error obteniendo memoria de PostgreSQL para ${sessionId}: ${error.message}`);
        return null;
    }
}

export async function saveMemory(sessionId: string, storeId: string, phone: string, history: OpenAI.Chat.ChatCompletionMessageParam[]) {
    try {
        // Upsert logic for PostgreSQL via Drizzle
        await db.insert(sessions)
            .values({
                sessionId,
                storeId,
                phone,
                historyJson: history, // JSONB acepta objetos directos
                updatedAt: new Date()
            })
            .onConflictDoUpdate({
                target: sessions.sessionId,
                set: {
                    historyJson: history,
                    updatedAt: new Date()
                }
            });
    } catch (error: any) {
        logger.error(`Error guardando memoria en PostgreSQL para ${sessionId}: ${error.message}`);
    }
}

export async function getAllSessions(storeId?: string): Promise<{ sessionId: string, storeId: string, history: OpenAI.Chat.ChatCompletionMessageParam[], isPaused: boolean, updatedAt: Date | null }[]> {
    try {
        let queryBuilder = db.select().from(sessions);
        
        if (storeId) {
            // @ts-ignore
            queryBuilder = queryBuilder.where(eq(sessions.storeId, storeId));
        }

        const rows = await queryBuilder.orderBy(desc(sessions.updatedAt));
        
        return rows.map(r => ({
            sessionId: r.sessionId,
            storeId: r.storeId,
            isPaused: !!r.isPaused,
            history: (typeof r.historyJson === 'string' ? JSON.parse(r.historyJson) : r.historyJson) as OpenAI.Chat.ChatCompletionMessageParam[],
            updatedAt: r.updatedAt
        }));
    } catch (error: any) {
        logger.error(`Error obteniendo sesiones: ${error.message}`);
        return [];
    }
}

export async function setSessionPause(sessionId: string, paused: boolean) {
    try {
        await db.update(sessions)
            .set({ isPaused: paused })
            .where(eq(sessions.sessionId, sessionId));
        logger.info(`Session ${sessionId} pause set to ${paused}`);
    } catch (error: any) {
        logger.error(`Error actualizando pausa en BD: ${error.message}`);
    }
}

/**
 * Verifica si el usuario ha excedido el límite de mensajes diarios.
 * Límite por defecto: 50 mensajes por día.
 */
export async function checkRateLimit(sessionId: string, dailyLimit: number = 50): Promise<{ allowed: boolean, remaining: number }> {
    try {
        const session = await getSession(sessionId);
        if (!session) return { allowed: true, remaining: dailyLimit };

        const now = new Date();
        const lastReset = session.lastResetAt ? new Date(session.lastResetAt) : new Date(0);
        
        // Si han pasado más de 24 horas, reseteamos el contador
        if (now.getTime() - lastReset.getTime() > 24 * 60 * 60 * 1000) {
            await db.update(sessions)
                .set({ messageCount: 0, lastResetAt: now })
                .where(eq(sessions.sessionId, sessionId));
            return { allowed: true, remaining: dailyLimit };
        }

        const count = session.messageCount || 0;
        return { 
            allowed: count < dailyLimit, 
            remaining: Math.max(0, dailyLimit - count) 
        };
    } catch (error: any) {
        logger.error(`Error verificando rate limit para ${sessionId}: ${error.message}`);
        return { allowed: true, remaining: 0 };
    }
}

export async function deleteSession(sessionId: string) {
    try {
        await db.delete(sessions).where(eq(sessions.sessionId, sessionId));
    } catch (error: any) {
        logger.error(`Error eliminando sesión ${sessionId}: ${error.message}`);
    }
}

/** Marca (o desmarca) que un contacto pidió no recibir más mensajes proactivos. */
export async function setOptOut(sessionId: string, optedOut: boolean) {
    try {
        await db.update(sessions)
            .set({ optedOut })
            .where(eq(sessions.sessionId, sessionId));
        logger.info(`🚫 Opt-out de ${sessionId} => ${optedOut}`);
    } catch (error: any) {
        logger.error(`Error actualizando opt-out de ${sessionId}: ${error.message}`);
    }
}

/**
 * Cuántos mensajes proactivos salieron de una tienda en las últimas 24h.
 * Se consulta contra la BD (no en memoria) para que el tope sobreviva a reinicios.
 */
export async function countRemarketingLast24h(storeId: string): Promise<number> {
    try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const rows = await db.select({ n: sql<number>`count(*)::int` })
            .from(sessions)
            .where(and(
                eq(sessions.storeId, storeId),
                gte(sessions.lastRemarketingAt, since)
            ));
        return Number(rows[0]?.n ?? 0);
    } catch (error: any) {
        logger.error(`Error contando remarketing de ${storeId}: ${error.message}`);
        // Ante la duda, devolvemos un número alto para NO enviar.
        return Number.MAX_SAFE_INTEGER;
    }
}

export async function incrementMessageCount(sessionId: string) {
    try {
        await db.update(sessions)
            .set({ messageCount: sql`${sessions.messageCount} + 1` })
            .where(eq(sessions.sessionId, sessionId));
    } catch (error) {
        logger.error(`Error incrementando contador: ${error}`);
    }
}
