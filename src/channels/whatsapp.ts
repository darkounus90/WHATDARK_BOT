import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { logger } from '../utils/logger';
import { handleUserMessage } from '../bot/agent';
import { recordUserActivity, startRemarketingCron } from '../bot/remarketing';

// Set para guardar los chats donde intervino un humano y el bot debe callarse
const pausedChats = new Set<string>();
const currentlyReplying = new Set<string>();

// Inicializamos el cliente de WhatsApp
// LocalAuth guarda la sesión en caché para no pedir el QR en cada reinicio
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        // Reducimos el peso de Chromium
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    }
});

export function initWhatsApp() {
    client.on('qr', (qr) => {
        logger.info('Escanea el siguiente código QR con tu WhatsApp para iniciar sesión:');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        logger.info('¡Cliente de WhatsApp conectado y listo para recibir mensajes!');
        startRemarketingCron(client);
    });

    client.on('authenticated', () => {
        logger.info('Autenticación exitosa.');
    });

    client.on('auth_failure', (msg) => {
        logger.error('Error de autenticación', msg);
    });

    // Detectar si el dueño del bot contesta desde su celular (Handover Humano)
    client.on('message_create', async (message) => {
        // Ignorar mensajes del pasado que WhatsApp sincroniza de golpe al encender
        const isOldMessage = (Date.now() - (message.timestamp * 1000)) > 30000;
        if (isOldMessage) return;

        if (message.fromMe && !message.to.includes('@g.us') && !message.isStatus) {
            
            // PALABRA MÁGICA: Si el dueño escribe "!bot", reactiva el bot y oculta el mensaje
            if (message.body.trim().toLowerCase() === '!bot') {
                pausedChats.delete(message.to);
                logger.info(`🤖 [BOT REACTIVADO] Has devuelto el chat ${message.to} al bot autónomo.`);
                // Borrar el '!bot' para todos para que el cliente no lo lea
                message.delete(true).catch(() => {});
                return;
            }

            // Si nuestro bot estaba a la mitad de responder a este chat y mandó un mensaje, lo ignoramos
            if (currentlyReplying.has(message.to)) {
                return;
            }

            if (!pausedChats.has(message.to)) {
                logger.info(`[HUMANO] Asesor detectado respondiendo a ${message.to}. El bot se pausará silenciosamente para este chat.`);
                pausedChats.add(message.to);
            }
        }
    });

    client.on('message', async (message) => {
        try {
            // Ignorar mensajes viejos del historial igual que arriba
            const isOldMessage = (Date.now() - (message.timestamp * 1000)) > 30000;
            if (isOldMessage) return;

            // Ignoramos mensajes de grupos y estados, solo chats directos
            if (message.isStatus || message.from.includes('@g.us')) return;

            // Si un humano tomó el control, el bot ignora el mensaje
            if (pausedChats.has(message.from)) return;

            logger.info(`Mensaje recibido de ${message.from}: ${message.body || '[Contenido Multimedia]'}`);

            // Registramos la actividad del usuario para el motor de remarketing
            recordUserActivity(message.from);

            // Mostrar "escribiendo..."
            const chat = await message.getChat();
            await chat.sendStateTyping();

            // Descargar imagen si existe
            let mediaData = undefined;
            if (message.hasMedia) {
                const media = await message.downloadMedia();
                if (media && media.mimetype.includes('image')) {
                    logger.info(`📸 Imagen detectada y descargada de ${message.from}`);
                    mediaData = { mimetype: media.mimetype, data: media.data };
                }
            }

            // Procesar el mensaje a través de nuestro agente de IA
            const aiResponse = await handleUserMessage(message.from, message.body, mediaData);

            // Enviar la respuesta
            currentlyReplying.add(message.from);
            await client.sendMessage(message.from, aiResponse);
            
            // Liberamos el candado en 5 segundos, tiempo suficiente para que salte el evento message_create de whatsapp-web.js
            setTimeout(() => currentlyReplying.delete(message.from), 5000);

            // Finalizar estado de "escribiendo"
            await chat.clearState();

        } catch (error: any) {
            logger.error(`Error procesando mensaje de ${message.from}: ${error.message}`);
            // NOTA: Eliminamos el mensaje de error al cliente para no hacerle spam si la API falla 
        }
    });

    client.initialize();
}
