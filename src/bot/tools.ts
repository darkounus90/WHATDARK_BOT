import OpenAI from 'openai';
import axios from 'axios';
import { searchProducts, getProductById, getAllProducts, getProductImages } from '../data/catalog';
import { logger } from '../utils/logger';

export type PendingImage = { mimetype: string; base64: string; caption?: string };

const MAX_IMAGES_PER_SESSION = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Cola de imágenes POR SESIÓN. Nunca un array global del módulo: con uno
// compartido, dos clientes atendidos a la vez se cruzan las fotos — y en
// multi-tenant eso significa entregar el catálogo de una tienda a otra.
const pendingImages = new Map<string, PendingImage[]>();

// Sesiones que pidieron cerrarse. El agente lo consulta al final para no
// volver a guardar el historial que se acaba de descartar.
const closeRequested = new Set<string>();

/** Saca (y vacía) las imágenes pendientes de una sesión. */
export function takePendingImages(sessionId: string): PendingImage[] {
    const images = pendingImages.get(sessionId) || [];
    pendingImages.delete(sessionId);
    return images;
}

/** Descarta imágenes encoladas que ya no se van a enviar. */
export function discardPendingImages(sessionId: string) {
    pendingImages.delete(sessionId);
}

export function consumeCloseRequest(sessionId: string): boolean {
    if (!closeRequested.has(sessionId)) return false;
    closeRequested.delete(sessionId);
    return true;
}

function queueImage(sessionId: string, image: PendingImage) {
    const queue = pendingImages.get(sessionId) || [];
    if (queue.length >= MAX_IMAGES_PER_SESSION) return;
    queue.push(image);
    pendingImages.set(sessionId, queue);
}

/** Descarga una imagen del catálogo. Las URLs las escribe el dueño de la tienda, así que validamos. */
async function fetchImage(url: string): Promise<PendingImage | null> {
    const dataUri = url.match(/^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/);
    if (dataUri) return { mimetype: dataUri[1], base64: dataUri[2] };

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;

    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxContentLength: MAX_IMAGE_BYTES,
        maxRedirects: 2
    });

    const mimetype = String(response.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
    if (!mimetype.startsWith('image/')) return null;

    return { mimetype, base64: Buffer.from(response.data).toString('base64') };
}

export const botTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'search_products',
            description: 'Busca productos en el catálogo de la tienda de acuerdo a una búsqueda (query). Retorna una lista de productos.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'El término de búsqueda (por ejemplo: "audífonos bluetooth", "bicicleta urbana").'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_all_products',
            description: 'Obtiene la lista completa de todos los productos disponibles en la tienda. Úsalo cuando el cliente pregunte "qué productos tienes" o si quieres ver todo el catálogo para recomendar algo.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_product_details',
            description: 'Obtiene toda la información (incluyendo stock, precio, descripciones, tallas) de un producto específico dado su ID.',
            parameters: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: 'El ID exacto del producto (por ejemplo: "audifonos-pro").'
                    }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'send_product_image',
            description: 'Envía la foto de un producto al cliente por WhatsApp. Úsalo cuando el cliente pida ver el producto, pregunte cómo se ve, o cuando se lo estés recomendando. Se envía junto con tu respuesta de texto.',
            parameters: {
                type: 'object',
                properties: {
                    product_id: {
                        type: 'string',
                        description: 'El ID del producto cuya foto quieres enviar.'
                    }
                },
                required: ['product_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'close_conversation',
            description: 'Cierra y reinicia la conversación. Úsalo ÚNICAMENTE cuando el cliente se despida claramente o confirme que no necesita nada más ("gracias, eso es todo", "chao", "listo por ahora"). NO lo uses si solo dice "gracias" y sigue preguntando.',
            parameters: {
                type: 'object',
                properties: {
                    reason: {
                        type: 'string',
                        description: 'Razón breve del cierre (ej: "cliente se despidió", "compra completada").'
                    }
                },
                required: ['reason']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'generate_payment_link',
            description: 'Devuelve el link de pago oficial de un producto del catálogo. Úsalo cuando el cliente quiera pagar con tarjeta o pedir el producto. Nunca inventes links de pago: si esta herramienta no devuelve uno, no existe.',
            parameters: {
                type: 'object',
                properties: {
                    product_id: {
                        type: 'string',
                        description: 'El ID del producto a comprar.'
                    }
                },
                required: ['product_id']
            }
        }
    }
];

export async function executeTool(name: string, args: any, storeId: string, senderPhone: string, sessionId?: string): Promise<string> {
    logger.info(`Ejecutando tool: ${name}`, args);
    try {
        switch (name) {
            case 'search_products':
                const products = await searchProducts(args.query, storeId);
                if (products.length === 0) {
                    const allProd = await getAllProducts(storeId);
                    if (allProd.length > 0) {
                        return JSON.stringify({ 
                            nota: "No hay coincidencias exactas para esa palabra, pero aquí tienes otros productos disponibles en la tienda para que analices si alguno le sirve:", 
                            productos: allProd.slice(0, 10) 
                        });
                    }
                    return JSON.stringify({ error: "No se encontraron productos y el catálogo está vacío." });
                }
                return JSON.stringify(products);
                
            case 'list_all_products':
                const all = await getAllProducts(storeId);
                return JSON.stringify(all);
            
            case 'get_product_details':
                const product = await getProductById(args.id, storeId);
                if (!product) return JSON.stringify({ error: "No se encontró el producto con ese ID." });
                return JSON.stringify(product);
 
            case 'generate_payment_link': {
                // El link de pago SIEMPRE sale del catálogo real de la tienda (checkoutUrl).
                // Nunca se genera ni se inventa uno.
                const target = await getProductById(args.product_id, storeId);

                if (!target) {
                    return JSON.stringify({
                        error: "No existe un producto con ese ID en esta tienda.",
                        instructions_for_ai: "NO inventes ningún link. Pregúntale al cliente cuál producto quiere y búscalo primero con search_products o list_all_products."
                    });
                }

                if (!target.checkoutUrl || !/^https?:\/\//i.test(target.checkoutUrl)) {
                    logger.warn(`Producto sin checkoutUrl configurado: ${target.id} (tienda ${storeId})`);
                    return JSON.stringify({
                        error: "Este producto no tiene link de pago configurado en el catálogo.",
                        instructions_for_ai: "NO inventes ningún link ni des instrucciones de pago. Dile al cliente algo natural como que ya le confirmas el medio de pago y que en un momento le escribe un asesor para cerrar el pedido."
                    });
                }

                return JSON.stringify({
                    success: true,
                    producto: target.name,
                    link: target.checkoutUrl,
                    instructions_for_ai: "Envía este link tal cual, sin modificarlo, junto a este aviso exacto: '⚠️ Aviso importante sobre el pago: El proceso de pago se realiza en nuestra plataforma segura. Haz clic en el enlace y sigue las instrucciones que aparecen en pantalla. Por tu seguridad, NUNCA compartas los datos de tu tarjeta por este chat. Si tienes problemas con el pago, contáctanos por este mismo medio y te ayudaremos. 🔒' No expliques el proceso paso a paso."
                });
            }

            case 'send_product_image': {
                if (!sessionId) {
                    return JSON.stringify({ error: 'No hay sesión activa para enviar imágenes.' });
                }

                const urls = await getProductImages(args.product_id, storeId);
                if (urls.length === 0) {
                    return JSON.stringify({
                        success: false,
                        error: 'Ese producto no tiene foto cargada en el catálogo.',
                        instructions_for_ai: 'NO prometas enviar la foto ni digas que se está cargando. Descríbele el producto con palabras.'
                    });
                }

                const info = await getProductById(args.product_id, storeId);
                const baseName = info?.name || 'el producto';
                let queued = 0;

                for (let i = 0; i < urls.length && queued < MAX_IMAGES_PER_SESSION; i++) {
                    try {
                        const image = await fetchImage(urls[i]);
                        if (!image) continue;
                        queueImage(sessionId, { ...image, caption: queued === 0 ? `📸 ${baseName}` : undefined });
                        queued++;
                    } catch (downloadError: any) {
                        logger.error(`Error descargando imagen de ${args.product_id}: ${downloadError.message}`);
                    }
                }

                if (queued === 0) {
                    return JSON.stringify({
                        success: false,
                        error: 'No se pudo descargar la foto del producto.',
                        instructions_for_ai: 'NO prometas enviar la foto. Descríbele el producto con palabras.'
                    });
                }

                return JSON.stringify({
                    success: true,
                    message: `${queued} foto(s) de ${baseName} salen junto a tu respuesta.`,
                    instructions_for_ai: 'Las fotos se envían automáticamente. No las describas ni anuncies que las vas a mandar.'
                });
            }

            case 'close_conversation': {
                if (!sessionId) {
                    return JSON.stringify({ error: 'No hay sesión activa para cerrar.' });
                }
                // Se marca, no se borra aquí: el agente todavía tiene que guardar
                // el cierre. Borrar en este punto lo sobrescribiría el saveMemory final.
                closeRequested.add(sessionId);
                logger.info(`🔚 Cierre solicitado para ${sessionId}: ${args.reason}`);
                return JSON.stringify({
                    success: true,
                    instructions_for_ai: 'Despídete en una sola línea, corta y cálida. El historial se reinicia solo.'
                });
            }

            default:
                return JSON.stringify({ error: "Función no reconocida." });
        }
    } catch (error: any) {
        logger.error(`Error ejecutando la tool ${name}: ${error.message}`);
        return JSON.stringify({ error: `Hubo un error inesperado al procesar la tool ${name}` });
    }
}
