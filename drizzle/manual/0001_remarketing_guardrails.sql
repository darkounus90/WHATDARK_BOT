-- Guardarraíles anti-baneo para el motor de remarketing.
--
-- EJECUTAR A MANO contra Postgres/Supabase (por ejemplo desde el SQL Editor).
-- NO usar `migrate.ts`: ese script hace DROP TABLE de products/sessions/stores
-- y borraría los datos de producción.
--
-- Es idempotente: se puede correr varias veces sin romper nada.

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "opted_out" boolean DEFAULT false;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "remarketing_count" integer DEFAULT 0;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "last_remarketing_at" timestamp;

-- Backfill: las filas que ya existían quedan en NULL y NULL no pasa los filtros.
UPDATE "sessions" SET "opted_out" = false WHERE "opted_out" IS NULL;
UPDATE "sessions" SET "remarketing_count" = 0 WHERE "remarketing_count" IS NULL;

-- El cron consulta estas columnas cada 10 minutos.
CREATE INDEX IF NOT EXISTS "sessions_remarketing_idx"
    ON "sessions" ("remarketing_sent", "opted_out", "last_message_at");

CREATE INDEX IF NOT EXISTS "sessions_store_remarketing_idx"
    ON "sessions" ("store_id", "last_remarketing_at");
