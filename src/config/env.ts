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
    NODE_ENV: process.env.NODE_ENV || 'development',
    DASHBOARD_USER: process.env.DASHBOARD_USER || 'admin',
    // Sin valor por defecto a propósito: un default conocido es una puerta abierta.
    DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD || '',
    // Saltos de proxy en los que confiar para obtener la IP real del cliente.
    // Detrás de ngrok o un reverse proxy, poner 1. En 0, el rate limit del
    // login ve una sola IP para todo el mundo.
    TRUST_PROXY: Number(process.env.TRUST_PROXY || 0),
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN || '',
    META_PHONE_ID: process.env.META_PHONE_ID || '',
    META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN || '',
    NGROK_AUTHTOKEN: process.env.NGROK_AUTHTOKEN || '',
    NGROK_DOMAIN: process.env.NGROK_DOMAIN || '',
    JWT_SECRET: process.env.JWT_SECRET || '',

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
    REMARKETING_OPTOUT_TEXT: process.env.REMARKETING_OPTOUT_TEXT || 'Si no quieres que te escriba más, respóndeme STOP 🙏',

    // --- Monitor de salud del número ---
    // Umbrales a partir de los cuales el bot se frena solo. No evitan un baneo,
    // pero permiten ver la trayectoria y parar antes de llegar al final.
    HEALTH_ENABLED: (process.env.HEALTH_ENABLED || 'true').toLowerCase() !== 'false',
    // Fallos de entrega sobre el total de envíos (24 h). Señal dura: si empieza
    // a fallar el envío, probablemente ya te están bloqueando.
    HEALTH_MAX_FAILURE_RATE: Number(process.env.HEALTH_MAX_FAILURE_RATE || 0.15),
    // Cuánta gente pide STOP sobre el total de contactos (7 días).
    HEALTH_MAX_OPTOUT_RATE: Number(process.env.HEALTH_MAX_OPTOUT_RATE || 0.08),
    // Cuánto habla el bot por cada mensaje que recibe (24 h).
    HEALTH_MAX_OUTBOUND_RATIO: Number(process.env.HEALTH_MAX_OUTBOUND_RATIO || 2.5),
    // Qué proporción de los seguimientos consigue respuesta (7 días).
    HEALTH_MIN_PROACTIVE_REPLY_RATE: Number(process.env.HEALTH_MIN_PROACTIVE_REPLY_RATE || 0.15),
    // Días de bitácora que se conservan.
    HEALTH_RETENTION_DAYS: Number(process.env.HEALTH_RETENTION_DAYS || 30),

    // --- Presentación en el primer contacto ---
    // El cliente suele llegar desde la web, un anuncio o una redirección desde
    // otro número: no sabe quién le está escribiendo. La instrucción se inyecta
    // en el prompt para que el bot se presente Y responda en el mismo mensaje,
    // en vez de soltar un saludo robótico aparte.
    FIRST_CONTACT_ENABLED: (process.env.FIRST_CONTACT_ENABLED || 'true').toLowerCase() !== 'false',
    // Tras cuántas horas de silencio se vuelve a presentar.
    FIRST_CONTACT_AFTER_HOURS: Number(process.env.FIRST_CONTACT_AFTER_HOURS || 24),
    FIRST_CONTACT_INSTRUCTION: process.env.FIRST_CONTACT_INSTRUCTION ||
        'CONTEXTO: es el primer mensaje de este cliente. Probablemente llegó desde la web, un anuncio o el otro número del negocio, así que NO sabe quién le está escribiendo y puede desconfiar. Empieza diciendo en pocas palabras de qué negocio eres, con naturalidad, y sigue de inmediato con lo que te preguntó — todo en el mismo mensaje, sin saludo largo ni presentación formal.'
};

// --- Validación de arranque ---
// Estos valores protegen las claves de API de todos tus clientes. Si faltan o
// son un default conocido, el proceso no arranca: es preferible a quedar abierto.
const DEFAULTS_INSEGUROS = [
    'super-secreto-ai-bot-99', 'admin123', 'mi_token_secreto_ecommerce',
    'changeme', 'secret', 'password', '123456'
];

const errores: string[] = [];

if (!config.JWT_SECRET) {
    errores.push('JWT_SECRET no está definido en el .env');
} else if (DEFAULTS_INSEGUROS.includes(config.JWT_SECRET)) {
    errores.push('JWT_SECRET usa un valor por defecto conocido; cualquiera puede falsificar sesiones');
} else if (config.JWT_SECRET.length < 32) {
    errores.push('JWT_SECRET es demasiado corto (mínimo 32 caracteres)');
}

if (!config.DASHBOARD_PASSWORD) {
    errores.push('DASHBOARD_PASSWORD no está definido en el .env');
} else if (DEFAULTS_INSEGUROS.includes(config.DASHBOARD_PASSWORD)) {
    errores.push('DASHBOARD_PASSWORD usa un valor por defecto conocido');
}

if (errores.length > 0) {
    console.error('\n❌ El bot no puede arrancar por configuración insegura:\n');
    for (const e of errores) console.error(`   • ${e}`);
    console.error('\n   Genera un secreto fuerte con:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n');
    process.exit(1);
}

if (config.DASHBOARD_PASSWORD.length < 12) {
    console.warn('⚠️  DASHBOARD_PASSWORD tiene menos de 12 caracteres. Esa cuenta ve las claves de API de todas las tiendas.');
}

// Validación simple
if (!config.OPENAI_API_KEY) {
    console.warn("⚠️ ADVERTENCIA: No se ha configurado OPENAI_API_KEY en el archivo .env!");
}
if (!config.META_ACCESS_TOKEN) {
    console.warn("⚠️ ADVERTENCIA: No se ha configurado META_ACCESS_TOKEN para la WhatsApp Cloud API.");
}
