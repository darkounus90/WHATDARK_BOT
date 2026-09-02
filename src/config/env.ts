import dotenv from 'dotenv';
import path from 'path';

// Cargar variables de entorno desde .env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export const config = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    OPENAI_API_KEY_2: process.env.OPENAI_API_KEY_2 || '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || '',
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    STORE_NAME: process.env.STORE_NAME || 'nuestro ecommerce',
    PORT: process.env.PORT || 3000,
    DASHBOARD_USER: process.env.DASHBOARD_USER || 'admin',
    DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD || 'admin123',
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN || '',
    META_PHONE_ID: process.env.META_PHONE_ID || '',
    META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN || 'mi_token_secreto_ecommerce',
    NGROK_AUTHTOKEN: process.env.NGROK_AUTHTOKEN || '',
    NGROK_DOMAIN: process.env.NGROK_DOMAIN || '',
    JWT_SECRET: process.env.JWT_SECRET || 'super-secreto-ai-bot-99',

    // --- Remarketing: guardarraíles anti-baneo ---
    // Meta no banea por la librería que uses, banea por comportamiento:
    // ráfagas de salientes, mensajes fuera de hora, insistir sin opt-out.
    REMARKETING_ENABLED: (process.env.REMARKETING_ENABLED || 'true').toLowerCase() !== 'false',
    REMARKETING_TIMEZONE: process.env.REMARKETING_TIMEZONE || 'America/Bogota',
    REMARKETING_START_HOUR: Number(process.env.REMARKETING_START_HOUR || 9),   // no antes de las 9am
    REMARKETING_END_HOUR: Number(process.env.REMARKETING_END_HOUR || 20),      // no después de las 8pm
    REMARKETING_MIN_HOURS: Number(process.env.REMARKETING_MIN_HOURS || 2),     // esperar mínimo 2h de silencio
    REMARKETING_MAX_HOURS: Number(process.env.REMARKETING_MAX_HOURS || 20),    // <24h: cabe en la ventana de servicio
    REMARKETING_MAX_PER_CONTACT: Number(process.env.REMARKETING_MAX_PER_CONTACT || 2),   // tope de por vida
    REMARKETING_MAX_PER_STORE_DAY: Number(process.env.REMARKETING_MAX_PER_STORE_DAY || 40),
    REMARKETING_BATCH_SIZE: Number(process.env.REMARKETING_BATCH_SIZE || 10),  // por tick de 10 min
    REMARKETING_MIN_DELAY_MS: Number(process.env.REMARKETING_MIN_DELAY_MS || 8000),
    REMARKETING_MAX_DELAY_MS: Number(process.env.REMARKETING_MAX_DELAY_MS || 25000),
    REMARKETING_OPTOUT_TEXT: process.env.REMARKETING_OPTOUT_TEXT || 'Si no quieres que te escriba más, respóndeme STOP 🙏'
};

// Validación simple
if (!config.OPENAI_API_KEY) {
    console.warn("⚠️ ADVERTENCIA: No se ha configurado OPENAI_API_KEY en el archivo .env!");
}
if (!config.META_ACCESS_TOKEN) {
    console.warn("⚠️ ADVERTENCIA: No se ha configurado META_ACCESS_TOKEN para la WhatsApp Cloud API.");
}
