import catalog from './catalog.json';

export interface Product {
    id: string;
    nombre: string;
    categoria: string;
    descripcion_corta: string;
    descripcion_larga: string;
    precio: number;
    stock: number;
    colores?: string[];
    tallas?: number[];
    tags: string[];
}

/**
 * Busca productos en el catálogo basándose en una consulta de texto.
 * Compara contra el nombre, tags, categoría y descripción.
 */
export async function searchProducts(query: string): Promise<Product[]> {
    const lowerQuery = query.toLowerCase();
    const products = catalog as Product[];
    
    return products.filter(p => 
        p.nombre.toLowerCase().includes(lowerQuery) ||
        p.tags.some(t => t.toLowerCase().includes(lowerQuery)) ||
        p.categoria.toLowerCase().includes(lowerQuery) ||
        p.descripcion_corta.toLowerCase().includes(lowerQuery)
    ).slice(0, 5); // Retorna máximo 5 coincidencias
}

/**
 * Obtiene los detalles exactos de un producto dado su ID.
 */
export async function getProductById(id: string): Promise<Product | null> {
    const products = catalog as Product[];
    return products.find(p => p.id === id) || null;
}
