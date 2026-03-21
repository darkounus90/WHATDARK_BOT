import { config } from './config/env';
import { logger } from './utils/logger';
import { initWhatsApp } from './channels/whatsapp';

function bootstrap() {
    logger.info(`Iniciando AI Bot para Ecommerce: ${config.STORE_NAME}`);
    
    // Inicializar conexión con WhatsApp
    initWhatsApp();

    // Manejar cierres inesperados
    process.on('SIGINT', () => {
        logger.info('Cerrando el bot...');
        process.exit(0);
    });
}

bootstrap();
