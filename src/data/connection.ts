import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { config } from '../config/env';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Evitar que errores inesperados en el pool tiren la aplicación
pool.on('error', (err, client) => {
    console.error('Unexpected error on idle pg client', err);
});

export const db = drizzle(pool, { schema });
