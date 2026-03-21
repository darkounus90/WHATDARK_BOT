import dotenv from 'dotenv';
import path from 'path';

// Cargar variables de entorno desde .env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export const config = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    STORE_NAME: process.env.STORE_NAME || 'nuestro ecommerce',
    PORT: process.env.PORT || 3000
};

// Validación simple
if (!config.OPENAI_API_KEY) {
    console.warn("⚠️ ADVERTENCIA: No se ha configurado OPENAI_API_KEY en el archivo .env!");
}
