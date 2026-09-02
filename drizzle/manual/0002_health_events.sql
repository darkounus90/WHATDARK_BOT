-- Bitácora de señales de salud del número de WhatsApp.
--
-- EJECUTAR A MANO contra Postgres/Supabase. NO usar `migrate.ts`, que hace
-- DROP TABLE de products/sessions/stores. Es idempotente.

CREATE TABLE IF NOT EXISTS "health_events" (
    "id"         text PRIMARY KEY,
    "store_id"   text NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE,
    "type"       text NOT NULL,
    "session_id" text,
    "created_at" timestamp DEFAULT now() NOT NULL
);

-- El monitor agrupa por tipo dentro de una ventana de tiempo.
CREATE INDEX IF NOT EXISTS "health_events_store_time_idx"
    ON "health_events" ("store_id", "created_at");

CREATE INDEX IF NOT EXISTS "health_events_store_type_time_idx"
    ON "health_events" ("store_id", "type", "created_at");
