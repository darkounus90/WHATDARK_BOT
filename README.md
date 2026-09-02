# Bot de ventas por WhatsApp y Telegram (multi-tienda)

Proceso Node.js/TypeScript que atiende conversaciones de venta para varias tiendas a la vez desde una sola instancia. Cada tienda tiene su propio prompt de sistema, su catálogo, su número de WhatsApp (o su bot de Telegram) y, opcionalmente, su propia clave de API del modelo. Las conversaciones las resuelve un agente conversacional que consulta el catálogo mediante herramientas (function calling) contra PostgreSQL. Además del canal de atención, el proyecto incluye un panel web para administrar tiendas, productos y conversaciones, un motor de remarketing para reenganchar a quien dejó la conversación a medias, y un monitor que estima la salud del número de WhatsApp y frena los envíos proactivos cuando se deteriora.

---

## Arquitectura

Todo corre en un único proceso, arrancado desde `src/app.ts`, que levanta:

1. Un servidor **Express** con el panel de control y su API, autenticado con JWT en cookie `httpOnly`.
2. Un cliente de **whatsapp-web.js** por cada tienda activa en la base de datos.
3. Un bot de **Telegram** por cada tienda que tenga `telegram_bot_active` y token configurado.
4. El **cron de remarketing**, que se ejecuta cada 10 minutos.

El apagado (`SIGINT`/`SIGTERM`, excepciones no capturadas) cierra todos los navegadores de WhatsApp y detiene el polling de Telegram antes de salir.

### Persistencia

**PostgreSQL con Drizzle ORM** sobre `node-postgres` (pool de hasta 20 conexiones). La cadena de conexión se lee de `DATABASE_URL`. El esquema vive en `src/data/schema.ts`:

| Tabla | Contenido |
|---|---|
| `stores` | Una fila por tienda: nombre, prompt de sistema, clave de API, token de Telegram, correo de PQR, activa o no. |
| `products` | Catálogo por tienda: nombre, descripción, tipo, precio, URL de imagen y `checkout_url` (link de pago). |
| `sessions` | Una conversación: historial completo en `jsonb`, pausa manual, contador diario de mensajes y los campos de remarketing (`opted_out`, `remarketing_count`, `last_remarketing_at`). |
| `health_events` | Bitácora de señales del monitor de salud (`inbound`, `outbound`, `send_failed`, `opt_out`). |
| `users` | Usuarios del panel: `superadmin` o `store_owner` ligado a una tienda, con hash scrypt de contraseña. |

El aislamiento entre tiendas se apoya en el identificador de sesión: `storeId_telefono` en WhatsApp y `storeId_tg_chatId` en Telegram; las consultas al catálogo y a las sesiones filtran siempre por `store_id`.

### Canales

**WhatsApp (`src/channels/whatsapp.ts`)** — usa `whatsapp-web.js` con `LocalAuth`, es decir, una sesión de WhatsApp Web por tienda guardada en `.wwebjs_auth/`, y un Chromium por instancia levantado con Puppeteer. El QR de vinculación se expone en el panel y se registra en consola. Sobre el flujo de entrada:

- Ignora grupos, estados y difusiones.
- Descarta mensajes con más de 30 segundos de antigüedad: al reconectar, WhatsApp Web reenvía historial y esos eventos no son tráfico real.
- Resuelve los identificadores `@lid` al número de teléfono real.
- Encola los mensajes por sesión y espera entre 2 y 5 segundos antes de responder.
- Aplica un tope de 50 mensajes por sesión y día.
- **Handover**: si el dueño responde manualmente desde su móvil, el bot detecta el mensaje saliente que no salió de él y pausa ese chat. Se reactiva escribiendo `!bot`.

**Telegram (`src/channels/telegram.ts`)** — `node-telegram-bot-api` en modo polling, un bot por tienda. Reutiliza el mismo agente y las mismas herramientas que WhatsApp, y envía las fotos que el modelo haya encolado.

**No hay integración con la WhatsApp Cloud API de Meta.** El único transporte de WhatsApp es `whatsapp-web.js`.

### Agente (`src/bot/agent.ts`)

Habla con el modelo a través del SDK de `openai` apuntando a `OPENAI_BASE_URL`, es decir, contra un endpoint compatible con la API de OpenAI. Los modelos configurados hoy son de la familia **Gemini/Gemma**, ordenados en cascada: si uno responde 429, 503, 500, 404 o 400 se pasa al siguiente, y cada modelo se reintenta con la segunda clave de API si está definida. Los modelos de la lista que no admiten herramientas se invocan sin ellas.

Cada turno construye el prompt con el `system_prompt` de la tienda más el catálogo completo inyectado como contexto. El historial se guarda en `sessions.history_json` y se recorta a 15 mensajes. Si es el primer contacto —o si el cliente lleva más de `FIRST_CONTACT_AFTER_HOURS` horas en silencio— se añade al prompt de ese turno una instrucción para que el bot se presente dentro de la misma respuesta.

---

## Herramientas expuestas al modelo

Definidas en `src/bot/tools.ts`:

| Herramienta | Qué hace |
|---|---|
| `search_products` | Busca en el catálogo de la tienda por nombre y descripción (máximo 5 resultados). Si no hay coincidencias, devuelve hasta 10 productos del catálogo como alternativa. |
| `list_all_products` | Devuelve el catálogo completo de la tienda. |
| `get_product_details` | Devuelve un producto concreto por su ID. |
| `send_product_image` | Descarga la imagen del producto y la encola para enviarla junto a la respuesta de texto. Valida el protocolo y el tipo de contenido, y limita el tamaño (5 MB) y la cantidad (5 imágenes por sesión). |
| `generate_payment_link` | Devuelve el `checkout_url` que el dueño cargó en el catálogo. **No genera ni inventa links**: si el producto no tiene uno configurado, devuelve un error con instrucciones para que el modelo no improvise. |
| `close_conversation` | Marca la conversación para reiniciarla: tras responder la despedida, el historial se vacía y el siguiente mensaje empieza de cero. |

Las imágenes se encolan **por sesión**, no en una estructura global, para que dos clientes atendidos simultáneamente no se crucen fotos entre tiendas.

---

## Motor de remarketing

`src/bot/remarketing.ts` corre cada 10 minutos. Busca sesiones en silencio dentro de una ventana de tiempo, genera con el modelo un mensaje de seguimiento personalizado a partir del historial y del catálogo, y lo envía por WhatsApp (las sesiones de Telegram se saltan).

Los guardarraíles anti-baneo, todos configurables por entorno:

- **Interruptor general**: `REMARKETING_ENABLED=false` apaga el motor entero.
- **Horario**: sólo envía entre `REMARKETING_START_HOUR` y `REMARKETING_END_HOUR` en la zona horaria configurada (por defecto 9:00–20:00, `America/Bogota`).
- **Ventana de silencio**: el contacto tiene que llevar al menos `REMARKETING_MIN_HOURS` sin escribir y no más de `REMARKETING_MAX_HOURS` (por defecto 2 h y 20 h; el máximo se mantiene por debajo de 24 h).
- **Opt-out**: si el cliente responde `STOP` —o alguna de las variantes reconocidas en `src/utils/optout.ts`, como "baja", "no me escribas", "cancelar", "unsubscribe"— la sesión queda marcada como `opted_out` y deja de recibir seguimientos. La petición se atiende incluso con el chat pausado. El texto de `REMARKETING_OPTOUT_TEXT` se anexa siempre al mensaje de seguimiento, sin depender de que el modelo se acuerde de incluirlo.
- **Tope por contacto**: `REMARKETING_MAX_PER_CONTACT` seguimientos de por vida (2 por defecto). El contador no se reinicia cuando el cliente vuelve a escribir.
- **Tope por tienda y día**: `REMARKETING_MAX_PER_STORE_DAY` (40 por defecto), contado contra la base de datos, de modo que sobrevive a los reinicios del proceso.
- **Ritmo**: como mucho `REMARKETING_BATCH_SIZE` envíos por ciclo, con una pausa aleatoria de entre `REMARKETING_MIN_DELAY_MS` y `REMARKETING_MAX_DELAY_MS` entre uno y otro (8–25 s por defecto). Las ráfagas son el patrón que dispara bloqueos.
- **Salud**: antes de cada envío se consulta el monitor; si la tienda está degradada, el remarketing se suspende para esa tienda en ese ciclo.

---

## Monitor de salud del número

`src/bot/health.ts`. Como `whatsapp-web.js` no ofrece la calificación de calidad que sí da la API oficial, el monitor reconstruye una aproximación con lo que se puede observar desde dentro. Cada mensaje entrante, cada envío, cada fallo de envío y cada opt-out se anota en `health_events`.

Sobre esa bitácora evalúa cuatro señales, cada una con un mínimo de muestra para que un porcentaje sobre tres mensajes no dispare nada:

| Señal | Mide | Umbral por defecto | Mínimo de muestra |
|---|---|---|---|
| `failure_rate` | Envíos fallidos sobre el total de salientes (24 h) | > 0.15 | 20 salientes |
| `optout_rate` | Contactos que pidieron STOP sobre el total de contactos (7 días) | > 0.08 | 10 contactos |
| `outbound_ratio` | Mensajes enviados por cada mensaje recibido (24 h) | > 2.5 | 50 salientes |
| `proactive_reply_rate` | Seguimientos que consiguieron respuesta (7 días) | < 0.15 | 20 seguimientos |

El estado resultante es `ok`, `watch` (una señal rota), `degraded` (dos o más) o `critical` (fallos de entrega por encima del umbral, que es la señal más dura: si empiezan a fallar los envíos, es probable que ya haya bloqueos).

Qué hace con eso: **cualquier señal rota frena el saliente proactivo** —el remarketing deja de enviar para esa tienda mientras dure—, pero responder a quien escribe primero sigue permitido. El estado `critical` marca además `requiresAttention`, que pide revisión humana y **no** silencia al bot: responder a quien escribió primero sigue siendo lo más seguro que hace, y callarlo dejaría al negocio sin atención justo cuando algo va mal. Si el propio monitor falla, se deja pasar el envío: un problema del monitor no debe dejar la operación muerta.

El diagnóstico se cachea 5 minutos, se consulta en `GET /dashboard/api/health/:storeId` y la bitácora se purga cada hora conservando `HEALTH_RETENTION_DAYS` días.

---

## Panel de control

Servido en `/dashboard` (HTML estático en `public/`, API en `src/routes/dashboard.ts`), protegido con JWT. El login acepta el superadmin definido en el `.env` o cualquier usuario de la tabla `users`; las contraseñas se verifican con scrypt y los hashes SHA-256 del sistema anterior se migran al vuelo en el primer login. El endpoint de login tiene su propio límite de intentos.

Permite gestionar tiendas y sus bots (crear, editar, activar, arrancar la instancia y ver el QR), el CRUD de productos, extraer los datos de un producto desde una URL con ayuda del modelo (con validación anti-SSRF), listar conversaciones y responder manualmente —lo que pausa el bot en ese chat—, y administrar usuarios (sólo superadmin). Los secretos de cada tienda (clave de API, token de WhatsApp, token de Telegram) no se devuelven al navegador: la API sólo informa de si están o no configurados.

---

## Instalación y arranque

### Requisitos

- Node.js y npm. El proyecto compila a ES2022/CommonJS.
- PostgreSQL accesible por `DATABASE_URL`.
- Un endpoint compatible con la API de OpenAI y su clave.
- Cada instancia de WhatsApp levanta un Chromium mediante Puppeteer, así que el sistema necesita las librerías que Chromium requiere.

### Pasos

```bash
npm install
cp .env.example .env    # incompleto: completar con la tabla de variables de abajo
# crear el esquema en Postgres (ver "Migraciones")
npm run build && npm start
```

Para desarrollo, `npm run dev` ejecuta `src/app.ts` con `ts-node`.

En el arranque, `src/config/env.ts` valida la configuración y **aborta el proceso** si `JWT_SECRET` falta, es uno de los valores por defecto conocidos o tiene menos de 32 caracteres, o si `DASHBOARD_PASSWORD` falta o es un valor por defecto conocido.

### Migraciones

**Las migraciones se ejecutan a mano contra Postgres.** Los archivos de `drizzle/manual/` están pensados para pegarse en un cliente SQL (por ejemplo el editor SQL de Supabase) y son idempotentes:

- `drizzle/manual/0001_remarketing_guardrails.sql` — columnas `opted_out`, `remarketing_count`, `last_remarketing_at` en `sessions`, backfill e índices para el cron.
- `drizzle/manual/0002_health_events.sql` — tabla `health_events` y sus índices.

**No ejecutes `migrate.ts`.** Ese script hace `DROP TABLE ... CASCADE` de `products`, `sessions`, `stores` y `drizzle_migrations` antes de migrar: sobre una base de datos en producción borra los datos. Está en el repositorio por historia, no para usarse.

### Variables de entorno

Definidas en `src/config/env.ts`, salvo `DATABASE_URL`, que se lee directamente del entorno en `src/data/connection.ts` y `drizzle.config.ts`. No hay valores de ejemplo aquí a propósito: los valores por defecto que se indican son los que aplica el código cuando la variable no está.

**Obligatorias**

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | Cadena de conexión a PostgreSQL. |
| `JWT_SECRET` | Secreto de firma de las sesiones del panel. Mínimo 32 caracteres; sin él el proceso no arranca. |
| `DASHBOARD_PASSWORD` | Contraseña del superadmin. Sin ella el proceso no arranca. Avisa si tiene menos de 12 caracteres. |
| `OPENAI_API_KEY` | Clave del proveedor del modelo. Se usa como respaldo cuando la tienda no tiene la suya. |

**Modelo y canal**

| Variable | Por defecto | Descripción |
|---|---|---|
| `OPENAI_BASE_URL` | (vacío) | Endpoint compatible con OpenAI. Vacío significa la API de OpenAI. |
| `OPENAI_API_KEY_2` | (vacío) | Segunda clave; la cascada reintenta con ella cada modelo. |
| `OPENAI_MODEL` | `gpt-4o-mini` | Modelo usado sólo por la extracción de productos desde URL del panel. La conversación usa su propia cascada, definida en el código. |

**Panel y servidor**

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor Express. |
| `NODE_ENV` | `development` | Con `production` la cookie de sesión se marca `secure`. |
| `DASHBOARD_USER` | `admin` | Usuario del superadmin. |
| `TRUST_PROXY` | `0` | Saltos de proxy en los que confiar. Detrás de un reverse proxy hay que subirlo o el límite de intentos de login verá una sola IP para todo el mundo. |
| `STORE_NAME` | `nuestro ecommerce` | Nombre que se registra al arrancar. |

**Remarketing**

| Variable | Por defecto |
|---|---|
| `REMARKETING_ENABLED` | `true` |
| `REMARKETING_TIMEZONE` | `America/Bogota` |
| `REMARKETING_START_HOUR` / `REMARKETING_END_HOUR` | `9` / `20` |
| `REMARKETING_MIN_HOURS` / `REMARKETING_MAX_HOURS` | `2` / `20` |
| `REMARKETING_MAX_PER_CONTACT` | `2` |
| `REMARKETING_MAX_PER_STORE_DAY` | `40` |
| `REMARKETING_BATCH_SIZE` | `10` |
| `REMARKETING_MIN_DELAY_MS` / `REMARKETING_MAX_DELAY_MS` | `8000` / `25000` |
| `REMARKETING_OPTOUT_TEXT` | Texto que se anexa a todo seguimiento explicando cómo darse de baja. |

**Salud del número**

| Variable | Por defecto |
|---|---|
| `HEALTH_ENABLED` | `true` |
| `HEALTH_MAX_FAILURE_RATE` | `0.15` |
| `HEALTH_MAX_OPTOUT_RATE` | `0.08` |
| `HEALTH_MAX_OUTBOUND_RATIO` | `2.5` |
| `HEALTH_MIN_PROACTIVE_REPLY_RATE` | `0.15` |
| `HEALTH_RETENTION_DAYS` | `30` |

**Primer contacto**

| Variable | Por defecto |
|---|---|
| `FIRST_CONTACT_ENABLED` | `true` |
| `FIRST_CONTACT_AFTER_HOURS` | `24` |
| `FIRST_CONTACT_INSTRUCTION` | Instrucción que se inyecta en el prompt para que el bot se presente en el primer mensaje. |

**Declaradas pero sin uso**: `META_ACCESS_TOKEN`, `META_PHONE_ID`, `META_VERIFY_TOKEN`, `NGROK_AUTHTOKEN` y `NGROK_DOMAIN` están en `src/config/env.ts` reservadas para la futura migración a la Cloud API, pero ningún módulo las consume hoy. `META_ACCESS_TOKEN` produce un aviso en el arranque si falta, aunque no haga falta para nada.

---

## Pruebas

```bash
npm test
```

Compila y ejecuta las suites de `tests/`, que no requieren base de datos ni red:
cubren el hashing de contraseñas, la detección de opt-out, la evaluación del
monitor de salud, el recorte seguro del historial y las herramientas que se le
declaran al modelo.

## Limitaciones conocidas

- **Corre sobre `whatsapp-web.js`, una librería no oficial** que automatiza WhatsApp Web con un navegador. Esto va contra los términos de servicio de WhatsApp y conlleva **riesgo real de baneo del número**. Los guardarraíles de remarketing y el monitor de salud reducen la exposición y permiten ver el deterioro antes del final, pero no evitan un baneo.
- **La cobertura de pruebas es parcial.** `npm test` cubre las funciones puras —hashing de contraseñas, opt-out, evaluación de salud, recorte de historial y declaración de herramientas—, pero no hay pruebas de integración: nada ejercita la base de datos, los canales ni el agente contra un modelo real.
- **Las claves de API de cada tienda se guardan sin cifrar en la base de datos.** `stores.openai_api_key`, `stores.whatsapp_access_token` y `stores.telegram_token` son texto plano. El panel ya no las devuelve al navegador, pero cualquiera con acceso de lectura a la base de datos —o el superadmin, que administra todas las tiendas— las tiene en claro.
- **Los archivos de `drizzle/` no reconstruyen el esquema actual.** La migración base `drizzle/0000_*.sql` quedó desfasada respecto a `src/data/schema.ts`: no incluye la tabla `users`, ni las columnas de `stores` para Telegram y PQR, ni buena parte de las columnas de `sessions`. Los scripts de `drizzle/manual/` sólo cubren lo añadido después. Levantar una base de datos desde cero requiere completar el esquema a mano.
- **No hay seguimiento de pedidos.** `src/data/orders.ts` define los tipos, pero `getOrderById` devuelve siempre `null` y no lo llama nadie.
- **Restos de versiones anteriores.** La carpeta `data/` de la raíz guarda archivos del almacenamiento anterior que el código ya no lee.
