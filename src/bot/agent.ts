import OpenAI from 'openai';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { botTools, executeTool, consumeCloseRequest, discardPendingImages } from './tools';
import { getMemory, saveMemory, getSession } from '../data/database';
import { getAllProducts } from '../data/catalog';

const MAX_HISTORY_LENGTH = 15;

/**
 * ¿Hay que presentarse? Puro, para poder probarlo.
 * Es primer contacto si nunca hubo sesión, o si lleva suficiente tiempo en
 * silencio como para que ya no recuerde con quién estaba hablando.
 */
export function esPrimerContacto(
    updatedAt: Date | string | null | undefined,
    ahora: number = Date.now(),
    horasDeSilencio: number = config.FIRST_CONTACT_AFTER_HOURS
): boolean {
    if (!updatedAt) return true;
    const ultimo = new Date(updatedAt).getTime();
    if (!Number.isFinite(ultimo)) return true;
    return (ahora - ultimo) > horasDeSilencio * 60 * 60 * 1000;
}

const MODEL_CASCADE = [
    { id: 'gemini-3.1-flash-lite-preview', tools: true  },
    { id: 'gemini-2.5-flash-lite',         tools: true  },
    { id: 'gemini-2.5-flash',              tools: true  },
    { id: 'gemma-3-27b-it',                tools: false },
    { id: 'gemini-2.5-pro',                tools: true  },
    { id: 'gemma-3-4b-it',                 tools: false },
];

async function createWithCascade(
    apiKeys: string[],
    baseURL: string | undefined,
    params: Omit<Parameters<OpenAI['chat']['completions']['create']>[0], 'model'>
): Promise<{ completion: OpenAI.Chat.ChatCompletion; usedTools: boolean }> {
    let lastError: any;
    for (const entry of MODEL_CASCADE) {
        for (const apiKey of apiKeys) {
            try {
                const openai = new OpenAI({ apiKey, baseURL });
                const callParams: any = { ...params, model: entry.id };
                if (!entry.tools) {
                    delete callParams.tools;
                    delete callParams.tool_choice;
                }
                const result = await openai.chat.completions.create(callParams);
                if (entry.id !== MODEL_CASCADE[0].id) {
                    logger.warn(`Cascada: ${MODEL_CASCADE[0].id} falló, usando ${entry.id}`);
                }
                return { completion: result as OpenAI.Chat.ChatCompletion, usedTools: entry.tools };
            } catch (err: any) {
                lastError = err;
                const status = err.status ?? err.statusCode;
                if (status === 429 || status === 503 || status === 500 || status === 404 || status === 400) {
                    logger.warn(`Cascada: ${entry.id} [key ...${apiKey.slice(-4)}] → HTTP ${status}, probando siguiente...`);
                    continue;
                }
                throw err;
            }
        }
    }
    throw lastError;
}

async function buildCatalogContext(storeId: string): Promise<string> {
    try {
        const products = await getAllProducts(storeId);
        if (products.length === 0) return '';
        const lines = products.map(p => {
            const price = p.price != null ? `$${p.price}` : 'consultar precio';
            const url = p.checkoutUrl ? ` | Link: ${p.checkoutUrl}` : '';
            return `- [ID: ${p.id}] ${p.name} — ${price}${url}${p.description ? ` | ${p.description}` : ''}`;
        }).join('\n');
        return `\n\nCATÁLOGO DE PRODUCTOS DISPONIBLES:\n${lines}\n\nCuando el cliente quiera pagar, envíale el link del producto directamente del catálogo anterior. Si no tiene link de pago, dile que te contacte para coordinar.`;
    } catch {
        return '';
    }
}

async function getOrCreateSession(sessionId: string, systemPrompt: string): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
    const mem = await getMemory(sessionId);
    if (!mem || mem.length === 0) {
        return [{ role: 'system', content: systemPrompt }];
    }
    if (mem[0].role === 'system') {
        mem[0].content = systemPrompt;
    }
    return mem;
}

export async function handleUserMessage(
    sessionId: string,
    storeId: string,
    senderPhone: string,
    userText: string,
    systemPrompt: string,
    customApiKey: string | null,
    media?: {mimetype: string, data: string}
): Promise<string> {

    const catalogContext = await buildCatalogContext(storeId);
    let enrichedSystemPrompt = systemPrompt + catalogContext;

    // La instrucción vive solo en el prompt de este turno: al siguiente mensaje
    // el prompt se regenera sin ella, así que no se vuelve a presentar.
    if (config.FIRST_CONTACT_ENABLED) {
        const sesionPrevia = await getSession(sessionId);
        if (esPrimerContacto(sesionPrevia?.updatedAt)) {
            enrichedSystemPrompt += `\n\n${config.FIRST_CONTACT_INSTRUCTION}`;
            logger.info(`👋 [${storeId}] Primer contacto con ${senderPhone}: el bot se presenta.`);
        }
    }

    const history = await getOrCreateSession(sessionId, enrichedSystemPrompt);

    const baseURL = config.OPENAI_BASE_URL || undefined;
    const apiKeys = [
        customApiKey || config.OPENAI_API_KEY,
        ...(config.OPENAI_API_KEY_2 ? [config.OPENAI_API_KEY_2] : [])
    ].filter(Boolean);

    let contentPayload: any = userText || "El usuario envió un archivo sin texto.";
    if (media) {
        contentPayload = [
            { type: "text", text: userText || "¿Me puedes decir qué ves en esta foto conectándolo con la tienda?" },
            { type: "image_url", image_url: { url: `data:${media.mimetype};base64,${media.data}` } }
        ];
    }

    history.push({ role: 'user', content: contentPayload });

    if (history.length > MAX_HISTORY_LENGTH) {
        history.splice(1, history.length - MAX_HISTORY_LENGTH);
    }

    await saveMemory(sessionId, storeId, senderPhone, history);

    const sanitizedHistory = history.map(msg => {
        if (Array.isArray((msg as any).content)) {
            const text = (msg as any).content
                .filter((p: any) => p.type === 'text')
                .map((p: any) => p.text)
                .join(' ') || '[imagen]';
            return { ...msg, content: text };
        }
        return msg;
    }) as OpenAI.Chat.ChatCompletionMessageParam[];

    try {
        let { completion: aiResponse, usedTools } = await createWithCascade(apiKeys, baseURL, {
            messages: sanitizedHistory,
            tools: botTools,
            tool_choice: 'auto'
        });

        let responseMessage = aiResponse.choices[0].message;

        if (usedTools) {
            while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
                history.push(responseMessage);

                for (const toolCall of responseMessage.tool_calls) {
                    try {
                        const functionName = toolCall.function.name;
                        const functionArgs = JSON.parse(toolCall.function.arguments);
                        const functionResult = await executeTool(functionName, functionArgs, storeId, senderPhone, sessionId);
                        history.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: functionResult
                        });
                    } catch (parseError) {
                        logger.error(`Error parseando argumentos de tool ${toolCall.function.name}:`, toolCall.function.arguments);
                        history.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: JSON.stringify({ error: "Argumentos inválidos proporcionados por la IA." })
                        });
                    }
                }

                const next = await createWithCascade(apiKeys, baseURL, {
                    messages: history,
                    tools: botTools,
                    tool_choice: 'auto'
                });
                aiResponse = next.completion;
                responseMessage = aiResponse.choices[0].message;
            }
        }

        let finalContent = responseMessage.content || "Hubo un error de procesamiento.";

        if (finalContent.includes('Demasiadas solicitudes') || finalContent.includes('Too many requests')) {
            finalContent = "Lo siento, estoy recibiendo muchas consultas en este momento. Por favor, escríbeme de nuevo en unos minutos.";
        }

        history.push({ role: 'assistant', content: finalContent });

        let finalHistory = history;
        if (history.length > MAX_HISTORY_LENGTH) {
            finalHistory = [history[0], ...history.slice(history.length - MAX_HISTORY_LENGTH + 1)];
        }

        // Si la IA cerró la conversación, la próxima empieza de cero.
        if (consumeCloseRequest(sessionId)) {
            await saveMemory(sessionId, storeId, senderPhone, [{ role: 'system', content: enrichedSystemPrompt }]);
        } else {
            await saveMemory(sessionId, storeId, senderPhone, finalHistory);
        }

        return finalContent;

    } catch (error: any) {
        // Si la respuesta falló, no queremos mandar después fotos de una conversación que se cayó.
        discardPendingImages(sessionId);
        logger.error(`Error conversacional sesión ${sessionId}:`, error.message, error.status, JSON.stringify(error.error ?? error.response?.data ?? ''));
        const status = error.status ?? error.statusCode;
        if (status === 400) {
            logger.warn(`Sesión ${sessionId} con historial corrupto — limpiando y reintentando...`);
            const freshHistory: OpenAI.Chat.ChatCompletionMessageParam[] = [
                { role: 'system', content: enrichedSystemPrompt },
                { role: 'user', content: userText || 'Hola' }
            ];
            await saveMemory(sessionId, storeId, senderPhone, freshHistory);
            try {
                const { completion: retryResponse } = await createWithCascade(apiKeys, baseURL, {
                    messages: freshHistory,
                    tools: botTools,
                    tool_choice: 'auto'
                });
                const retryContent = retryResponse.choices[0].message.content || "Hubo un error de procesamiento.";
                freshHistory.push({ role: 'assistant', content: retryContent });
                await saveMemory(sessionId, storeId, senderPhone, freshHistory);
                return retryContent;
            } catch (retryErr: any) {
                logger.error(`Reintento fallido para ${sessionId}: ${retryErr.message}`);
            }
        }
        return "Lo siento, tengo un problema y no te puedo atender en este momento. Escribe de nuevo más tarde.";
    }
}
