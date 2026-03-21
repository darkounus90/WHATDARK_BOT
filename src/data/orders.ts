import orders from './orders.json';

export interface OrderItem {
    producto_id: string;
    cantidad: number;
}

export interface Order {
    order_id: string;
    cliente: string;
    fecha: string;
    estado: string;
    transportadora: string;
    guia: string | null;
    total: number;
    items: OrderItem[];
}

/**
 * Consulta el estado de un pedido por su Order ID exacto.
 */
export async function getOrderById(orderId: string): Promise<Order | null> {
    const allOrders = orders as Order[];
    // Limpiamos espacios y pasamos a mayúsculas por si acaso
    const normalizedQuery = orderId.trim().toUpperCase(); 
    return allOrders.find(o => o.order_id === normalizedQuery) || null;
}
