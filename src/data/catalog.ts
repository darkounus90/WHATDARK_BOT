import { db } from './connection';
import { products } from './schema';
import { eq, ilike, or, and } from 'drizzle-orm';
import { logger } from '../utils/logger';

export type Product = typeof products.$inferSelect;

function generateId(name: string): string {
    return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

export async function searchProducts(query: string, storeId: string): Promise<Product[]> {
    const lowerQuery = `%${query.toLowerCase()}%`;
    try {
        const rows = await db.query.products.findMany({
            where: and(
                eq(products.storeId, storeId),
                or(
                    ilike(products.name, lowerQuery),
                    ilike(products.description, lowerQuery)
                )
            ),
            limit: 5
        });
        return rows;
    } catch (e) {
        logger.error(`Error searching products: ${e}`);
        return [];
    }
}

export async function getProductById(id: string, storeId: string): Promise<Product | null> {
    try {
        const row = await db.query.products.findFirst({
            where: and(eq(products.id, id), eq(products.storeId, storeId))
        });
        return row || null;
    } catch (e) {
        logger.error(`Error getting product by id: ${e}`);
        return null;
    }
}

export async function getAllProducts(storeId?: string): Promise<Product[]> {
    try {
        if (storeId) {
            return await db.query.products.findMany({ where: eq(products.storeId, storeId) });
        }
        return await db.query.products.findMany();
    } catch (e) {
        logger.error(`Error getting all products: ${e}`);
        return [];
    }
}

/**
 * URLs de imagen de un producto. Nuestro schema guarda una sola (imageUrl),
 * pero devolvemos lista para poder crecer sin cambiar el llamador.
 */
export async function getProductImages(id: string, storeId: string): Promise<string[]> {
    const product = await getProductById(id, storeId);
    if (!product?.imageUrl?.trim()) return [];
    return [product.imageUrl.trim()];
}

export async function createProduct(product: Partial<Product>, storeId: string): Promise<Product | null> {
    const id = product.id || generateId(product.name || 'product');
    try {
        const [newProduct] = await db.insert(products).values({
            id,
            storeId: storeId,
            name: product.name || '',
            description: product.description || '',
            productType: product.productType || 'physical',
            price: product.price || 0,
            imageUrl: product.imageUrl || '',
            checkoutUrl: product.checkoutUrl || ''
        }).returning();
        return newProduct;
    } catch (e) {
        logger.error(`Error creating product: ${e}`);
        return null;
    }
}

export async function updateProduct(id: string, updates: Partial<Product>, storeId: string): Promise<Product | null> {
    try {
        const [updatedProduct] = await db.update(products)
            .set({
                name: updates.name,
                description: updates.description,
                productType: updates.productType,
                price: updates.price,
                imageUrl: updates.imageUrl,
                checkoutUrl: updates.checkoutUrl
            })
            .where(and(eq(products.id, id), eq(products.storeId, storeId)))
            .returning();
            
        return updatedProduct || null;
    } catch (e) {
        logger.error(`Error updating product: ${e}`);
        return null;
    }
}

export async function deleteProduct(id: string, storeId: string): Promise<boolean> {
    try {
        const result = await db.delete(products)
            .where(and(eq(products.id, id), eq(products.storeId, storeId)))
            .returning();
        return result.length > 0;
    } catch (e) {
        logger.error(`Error deleting product: ${e}`);
        return false;
    }
}
