import OpenAI from 'openai';
import { searchProducts, getProductById } from '../data/catalog';
import { getOrderById } from '../data/orders';
import { logger } from '../utils/logger';

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
            name: 'get_order_status',
            description: 'Consulta el estado de un pedido del cliente usando el ID de la orden.',
            parameters: {
                type: 'object',
                properties: {
                    order_id: {
                        type: 'string',
                        description: 'El número de orden. Ejemplo: "ORD-12345".'
                    }
                },
                required: ['order_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'add_to_cart_link',
            description: 'Genera un link directo de checkout o carrito para un producto, útil cuando el cliente ya decide comprar.',
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

export async function executeTool(name: string, args: any): Promise<string> {
    logger.info(`Ejecutando tool: ${name}`, args);
    try {
        switch (name) {
            case 'search_products':
                const products = await searchProducts(args.query);
                if (products.length === 0) return JSON.stringify({ error: "No se encontraron productos para esta búsqueda." });
                return JSON.stringify(products);
            
            case 'get_product_details':
                const product = await getProductById(args.id);
                if (!product) return JSON.stringify({ error: "No se encontró el producto con ese ID." });
                return JSON.stringify(product);

            case 'get_order_status':
                const order = await getOrderById(args.order_id);
                if (!order) return JSON.stringify({ error: "No se encontró la orden con ese ID. Asegúrate de que el formato sea ORD-XXXXX." });
                return JSON.stringify(order);

            case 'add_to_cart_link':
                // Mapeamos el ID a un link simulado (en el futuro esto será de la API del Ecommerce real)
                return JSON.stringify({
                    success: true,
                    link: `https://mitienda.com/checkout?product=${args.product_id}`
                });

            default:
                return JSON.stringify({ error: "Función no reconocida." });
        }
    } catch (error: any) {
        logger.error(`Error ejecutando la tool ${name}: ${error.message}`);
        return JSON.stringify({ error: `Hubo un error inesperado al procesar la tool ${name}` });
    }
}
