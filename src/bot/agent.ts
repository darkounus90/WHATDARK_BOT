import OpenAI from 'openai';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { SYSTEM_PROMPT } from './prompts';
import { botTools, executeTool } from './tools';

const openai = new OpenAI({
    apiKey: config.OPENAI_API_KEY
});

// Mapa para guardar el historial de la sesión en memoria
// Estructura: sessionId -> Array de Mensajes
const sessionMemory = new Map<string, OpenAI.Chat.ChatCompletionMessageParam[]>();
const MAX_HISTORY_LENGTH = 15; // Mantener solo los últimos N mensajes para no saturar tokens

/**
 * Obtiene el historial de una sesión o lo inicializa con el System Prompt.
 */
function getOrCreateSession(sessionId: string): OpenAI.Chat.ChatCompletionMessageParam[] {
    if (!sessionMemory.has(sessionId)) {
        sessionMemory.set(sessionId, [
            { role: 'system', content: SYSTEM_PROMPT }
        ]);
    }
    return sessionMemory.get(sessionId)!;
}

/**
 * Función principal para procesar el mensaje de un usuario.
 */
export async function handleUserMessage(sessionId: string, userText: string): Promise<string> {
    const history = getOrCreateSession(sessionId);
    
    // Agregar el mensaje del usuario al historial
    history.push({ role: 'user', content: userText });

    try {
        let aiResponse = await openai.chat.completions.create({
            model: 'gpt-4o-mini', // Usamos 4o-mini por rapidez y costo
            messages: history,
            tools: botTools,
            tool_choice: 'auto'
        });

        let responseMessage = aiResponse.choices[0].message;

        // Bucle para manejar las llamadas a herramientas (Function Calling)
        while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            // Guardamos la intención de usar herramientas en el historial
            history.push(responseMessage);

            // Ejecutamos las herramientas solicitadas
            for (const toolCall of responseMessage.tool_calls) {
                const functionName = toolCall.function.name;
                const functionArgs = JSON.parse(toolCall.function.arguments);
                
                // Ejecutamos la función
                const functionResult = await executeTool(functionName, functionArgs);
                
                // Retornamos el resultado al modelo
                history.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: functionResult
                });
            }

            // Llamamos a OpenAI de nuevo con los resultados de las tools
            aiResponse = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: history,
                tools: botTools, // Seguimos pasándolas por si necesita usar otra
                tool_choice: 'auto'
            });

            responseMessage = aiResponse.choices[0].message;
        }

        // Si ya no hay llamadas a herramientas, es el texto final
        const finalContent = responseMessage.content || "Lo siento, tuve un problema procesando tu respuesta.";
        
        // Guardar el mensaje final del asistente en el historial
        history.push({ role: 'assistant', content: finalContent });

        // Limpieza básica del historial si se hace muy largo (dejamos el System Prompt intacto en index 0)
        if (history.length > MAX_HISTORY_LENGTH) {
            const systemPrompt = history[0];
            const recentMessages = history.slice(history.length - MAX_HISTORY_LENGTH + 1);
            sessionMemory.set(sessionId, [systemPrompt, ...recentMessages]);
        }

        return finalContent;

    } catch (error: any) {
        logger.error(`Error en el motor conversacional para sesión ${sessionId}:`, error.message);
        return "Lo siento, en este momento presento problemas técnicos y no puedo responder. Por favor, intenta de nuevo más tarde o comunícate con un asesor humano.";
    }
}
