import fs from 'fs';
import path from 'path';
import { Client } from 'whatsapp-web.js';
import { logger } from '../utils/logger';

interface ActivityRecord {
    lastMessageAt: number;
    remarketingSent: boolean;
}

// Guardaremos los clics y tiempos en un archivito JSON para que no se pierdan si el VPS se reinicia
const DATA_FILE = path.join(__dirname, '../../data/remarketing.json');

function loadData(): Record<string, ActivityRecord> {
    if (fs.existsSync(DATA_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        } catch(e) {
            return {};
        }
    }
    return {};
}

async function saveData(data: Record<string, ActivityRecord>) {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // PARCHE DE AUDITORIA: Escritura asincrónica (Non-blocking I/O)
    fs.promises.writeFile(DATA_FILE, JSON.stringify(data, null, 2)).catch(err => {
        logger.error('Error crudo guardando el JSON asíncronamente:', err);
    });
}

let activities = loadData();

/**
 * Registra o actualiza la última vez que el usuario nos mandó un mensaje
 */
export function recordUserActivity(userId: string) {
    if (userId.includes('@g.us')) return; // No remarketing a grupos

    if (!activities[userId]) {
        activities[userId] = { lastMessageAt: Date.now(), remarketingSent: false };
    } else {
        activities[userId].lastMessageAt = Date.now();
        // Si nos volvieron a escribir antes del remarketing, reseteamos el marcador
        activities[userId].remarketingSent = false;
    }
    // No usamos await aquí porque es fire-and-forget
    saveData(activities);
}

/**
 * Arranca el temporizador de fondo. Revisa constantemente a quién hay que escribirle de nuevo.
 */
export function startRemarketingCron(client: Client) {
    logger.info("⏰ Motor de Remarketing INICIADO (Buscando carritos abandonados cada 10 minutos...)");
    
    // El bot se despierta cada 10 minutos a revisar la lista entera
    setInterval(async () => {
        const now = Date.now();
        
        // TIEMPO PARA DETONAR EL REMARKETING: 2 Horas (en milisegundos)
        const WAITING_TIME_MS = 2 * 60 * 60 * 1000; 
        
        // TIEMPO DE EXPIRACIÓN: Si ya pasaron más de 48 horas, se rinde y no le escribe nada para no hacer spam.
        const MAXIMUM_WAIT_TIME_MS = 48 * 60 * 60 * 1000;

        let shouldSave = false;

        for (const [userId, record] of Object.entries(activities)) {
            const timeSinceLastMessage = now - record.lastMessageAt;

            // Condición: No se le ha mandado el mensaje, lleva más de 2 horas en silencio y menos de 48.
            if (!record.remarketingSent && timeSinceLastMessage > WAITING_TIME_MS && timeSinceLastMessage < MAXIMUM_WAIT_TIME_MS) {
                try {
                    logger.info(`🔥 TRABAJO AUTOMÁTICO: Disparando mensaje de Remarketing a ${userId}...`);
                    
                    const msg = "¡Hola! Pasaba a saludarte rapidito 👋. Oye, como estuvimos hablando hace un rato del L-Treonato de Magnesio y me caíste súper bien, acabo de hablar con mi jefe. Me autorizó a darte ✨ prioridad VIP ✨ en el despacho si dejas tu pedido listo hoy mismo (Sale enseguida y el envío te sale 100% gratis). ¿Te lo pido de una vez? 💊";
                    
                    await client.sendMessage(userId, msg);
                    
                    activities[userId].remarketingSent = true;
                    shouldSave = true;
                } catch (error) {
                    logger.error(`Error enviando remarketing a ${userId}:`, error);
                }
            }
        }
        
        if (shouldSave) saveData(activities); // Guarda de fondo (asíncrono)
    }, 10 * 60 * 1000); // Revisa cada 10 minutos
}
