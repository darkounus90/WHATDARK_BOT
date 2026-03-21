import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { logger } from '../utils/logger';
import { handleUserMessage } from '../bot/agent';

// Inicializamos el cliente de WhatsApp
// LocalAuth guarda la sesión en caché para no pedir el QR en cada reinicio
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        // Reducimos el peso de Chromium
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

export function initWhatsApp() {
    client.on('qr', (qr) => {
        logger.info('Escanea el siguiente código QR con tu WhatsApp para iniciar sesión:');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        logger.info('¡Cliente de WhatsApp conectado y listo para recibir mensajes!');
    });

    client.on('authenticated', () => {
        logger.info('Autenticación exitosa.');
    });

    client.on('auth_failure', (msg) => {
        logger.error('Error de autenticación', msg);
    });

    client.on('message', async (message) => {
        try {
            // Ignoramos mensajes de grupos y estados, solo chats directos
            if (message.isStatus || message.from.includes('@g.us')) return;

            logger.info(`Mensaje recibido de ${message.from}: ${message.body}`);

            // Mostrar "escribiendo..."
            const chat = await message.getChat();
            await chat.sendStateTyping();

            // Procesar el mensaje a través de nuestro agente de IA
            const aiResponse = await handleUserMessage(message.from, message.body);

            // Enviar la respuesta
            await client.sendMessage(message.from, aiResponse);
            
            // Finalizar estado de "escribiendo"
            await chat.clearState();

        } catch (error: any) {
            logger.error(`Error procesando mensaje de ${message.from}: ${error.message}`);
            await client.sendMessage(message.from, "Lo siento, tuve un inconveniente procesando tu mensaje. Intenta de nuevo.");
        }
    });

    client.initialize();
}
