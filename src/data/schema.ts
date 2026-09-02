import { pgTable, text, timestamp, boolean, real, integer, jsonb } from 'drizzle-orm/pg-core';

export const stores = pgTable('stores', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    whatsappPhoneNumberId: text('whatsapp_phone_number_id').unique(),
    whatsappAccessToken: text('whatsapp_access_token'),
    openaiApiKey: text('openai_api_key'),
    systemPrompt: text('system_prompt').notNull(),
    pqrEmail: text('pqr_email'),
    telegramToken: text('telegram_token'),
    telegramBotActive: boolean('telegram_bot_active').default(false),
    isActive: boolean('is_active').default(true),
    createdAt: timestamp('created_at').defaultNow(),
});

export const products = pgTable('products', {
    id: text('id').primaryKey(),
    storeId: text('store_id').references(() => stores.id, { onDelete: 'cascade' }).notNull(),
    name: text('name').notNull(),
    description: text('description'),
    productType: text('product_type').default('physical'), // 'physical' | 'digital'
    price: real('price'),
    imageUrl: text('image_url'),
    checkoutUrl: text('checkout_url'), // Link directo a Hotmart u otra pasarela
    createdAt: timestamp('created_at').defaultNow(),
});

export const sessions = pgTable('sessions', {
    sessionId: text('session_id').primaryKey(),
    storeId: text('store_id').references(() => stores.id, { onDelete: 'cascade' }).notNull(),
    phone: text('phone').notNull(),
    historyJson: jsonb('history_json').notNull(),
    isPaused: boolean('is_paused').default(false),
    messageCount: real('message_count').default(0),
    lastResetAt: timestamp('last_reset_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
    lastMessageAt: timestamp('last_message_at').defaultNow(),
    remarketingSent: boolean('remarketing_sent').default(false),
    // --- Guardarraíles anti-baneo ---
    optedOut: boolean('opted_out').default(false),              // el cliente pidió no recibir más
    remarketingCount: integer('remarketing_count').default(0),  // cuántos seguimientos lleva de por vida
    lastRemarketingAt: timestamp('last_remarketing_at'),        // cuándo fue el último
});

export const users = pgTable('users', {
    id: text('id').primaryKey(),
    storeId: text('store_id').references(() => stores.id, { onDelete: 'cascade' }), // null para superadmin
    username: text('username').unique().notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').default('store_owner'), // 'superadmin' | 'store_owner'
    createdAt: timestamp('created_at').defaultNow(),
});

export type Store = typeof stores.$inferSelect;
export type NewStore = typeof stores.$inferInsert;
export type Product = typeof products.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type User = typeof users.$inferSelect;
