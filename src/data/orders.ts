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

export async function getOrderById(orderId: string, clientPhone: string): Promise<Order | null> {
    return null;
}
