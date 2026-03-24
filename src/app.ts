import express from 'express';
import cors from 'cors';
import { config } from './config/env';
import { logger } from './utils/logger';
import { whatsappRouter, sendWhatsAppMessage } from './channels/whatsapp';
import { startRemarketingCron } from './bot/remarketing';

function bootstrap() {
    logger.info(`Iniciando AI Bot para Ecommerce: ${config.STORE_NAME}`);
    
    // Iniciar el servidor Express para Recibir Webhooks
    const app = express();
    app.use(cors());
    app.use(express.json());

    // Rutear las peticiones de Meta a nuestro manejador
    app.use('/webhook/whatsapp', whatsappRouter);

    app.listen(config.PORT, () => {
        logger.info(`🌍 Servidor escuchando en el puerto ${config.PORT}`);
        logger.info(`🔗 Asegúrate de configurar este endpoint en Meta: http://[tu-ip-o-dominio]:${config.PORT}/webhook/whatsapp`);
    });

    // Iniciar cron de remarketing inyectando el envío por Cloud API
    startRemarketingCron(sendWhatsAppMessage);

    // Manejar cierres inesperados
    process.on('SIGINT', () => {
        logger.info('Cerrando el bot...');
        process.exit(0);
    });
}

bootstrap();
