import { Router, Request, Response } from 'express';
import axios from 'axios';
import { logger } from '../utils/logger';
import { config } from '../config/env';
import { handleUserMessage } from '../bot/agent';
import { recordUserActivity } from '../bot/remarketing';

export const whatsappRouter = Router();

const pausedChats = new Set<string>();
const currentlyReplying = new Set<string>();

// 1. Verificación del Webhook de Meta
whatsappRouter.get('/', (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.META_VERIFY_TOKEN) {
        logger.info('Webhook verificado exitosamente por Meta.');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// 2. Recepción de mensajes entrantes (POST Webhook)
whatsappRouter.post('/', async (req: Request, res: Response) => {
    // Retornar 200 inmediatamente para evitar retries de Meta (Timeouts limitados a pocos segundos)
    res.sendStatus(200);

    try {
        const body = req.body;

        if (body.object === 'whatsapp_business_account' && 
            body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
            
            const message = body.entry[0].changes[0].value.messages[0];
            const senderPhone = message.from;
            
            // Si no es texto (imágenes sin texto, notas de voz, etc.), por ahora guardamos texto vacío
            let userText = message.text?.body || '';

            // Handover Humano
            if (userText.trim().toLowerCase() === '!bot') {
                pausedChats.delete(senderPhone);
                logger.info(`🤖 [BOT REACTIVADO] El bot vuelve a tomar el control con ${senderPhone}.`);
                await sendWhatsAppMessage(senderPhone, "Bot reactivado correctamente. ¿En qué te puedo ayudar?");
                return;
            }

            // Ignorar si el bot está pausado temporal o permanentemente
            if (pausedChats.has(senderPhone)) return;
            if (currentlyReplying.has(senderPhone)) return;

            logger.info(`📩 Nuevo mensaje de ${senderPhone}: ${userText}`);

            // Registrar actividad
            recordUserActivity(senderPhone);

            // Bloqueamos el envio asincrono temporalmente
            currentlyReplying.add(senderPhone);

            // TODO: Podríamos descargar imágenes leyendo el media URL que envía Meta
            const mediaData = undefined;

            // Procesar con el Agente AI
            const aiResponse = await handleUserMessage(senderPhone, userText, mediaData);

            // Enviar respuesta al chat
            await sendWhatsAppMessage(senderPhone, aiResponse);

            // Liberamos el semáforo para nuevos mensajes
            currentlyReplying.delete(senderPhone);
        }
    } catch (error: any) {
        logger.error(`Error grave en webhook de WhatsApp: ${error.message}`);
    }
});

// 3. Función auxiliar para mandar el mensaje saliente apuntando a la Cloud API
export async function sendWhatsAppMessage(to: string, text: string) {
    if (!config.META_ACCESS_TOKEN || !config.META_PHONE_ID) {
        logger.error("❌ Faltan credenciales de Meta (Access Token o Phone ID) en las variables de entorno.");
        return;
    }

    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v19.0/${config.META_PHONE_ID}/messages`,
            headers: {
                Authorization: `Bearer ${config.META_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
            },
            data: {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: to,
                type: 'text',
                text: { body: text }
            }
        });
        logger.info(`✅ Respuesta de IA enviada a ${to}`);
    } catch (error: any) {
        logger.error(`❌ Error HTTP enviando a ${to}: ${error.response?.data?.error?.message || error.message}`);
    }
}
