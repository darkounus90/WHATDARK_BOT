# 🤖 WHATDARK BOT - AI Ecommerce Assistant

Bot inteligente para ventas en WhatsApp automatizado con Inteligencia Artificial Multimodal. Especializado en ventas directas, consultas de catálogo, reconocimiento visual de productos y cierres de venta automáticos con remarketing avanzado.

## 🚀 Características Principales (Última Versión)

*   **🧠 IA "Andrés" Humanizada**: Prompt optimizado para conversar como un humano experto real, enviando respuestas cortas y persuasivas. 
*   **👁️ Visión Artificial Integrada**: Completamente capaz de procesar e interpretar fotos (Base64) en tiempo real permitiendo al bot "ver" imágenes enviadas por clientes y relacionarlas con la tienda.
*   **🛡️ Handover Humano Inteligente**: Sistema Anti-Colisión. Si el dueño del negocio responde manualmente desde su aplicación móvil de WhatsApp, el bot de IA lo detecta instantáneamente, cede el control y se **silencia permanentemente** para ese chat de forma silenciosa para no interrumpir la venta.
*   **🕒 Protección Anti-Mensajes Fantasma (Sync-Safe)**: Mecanismo de seguridad con validación matemática de Timestamps (>30 Segundos = Basura). WhatsApp Web sincroniza historial al encender; el bot ignora selectivamente cualquier mensaje histórico para no saturarse y lee exclusivamente en tiempo real.
*   **🔄 Motor de Remarketing Autónomo**: Una base de datos ligera \`data/remarketing.json\` rastrea independientemente las conversaciones de cada usuario. Ejecuta un "Cron Job" background. Si un usuario charla y abandona la compra por un tiempo predefinido, el bot dispara automáticamente una **oferta VIP prioritaria** y un cupón silencioso logrando altísimas tasas de recuperación.
*   **🔌 Integración Proxy Multi-Modelo**: Adaptación nativa con endpoints no convencionales de LLM y proxies a través de un archivo `.env` personalizable (`OPENAI_BASE_URL`, `OPENAI_MODEL`). Totalmente testeado en la red **Claude 3.5 Sonnet** usando protocolos OpenAI.

## 💻 Instalación y Despliegue en VPS
El proyecto incluye un script de auto-arranque Windows Batch (`iniciar_bot_vps_windows.bat`) inteligente que autodetecta instalación, evita compilar de más, y asesina procesos zombies que pudiesen trabar SQLite o Chromium.

1.  Crear y configurar el archivo \`.env\` de variables obligatorias (\`OPENAI_API_KEY\`, \`OPENAI_BASE_URL\`, \`OPENAI_MODEL\`).
2.  Configurar pre-catálogos en \`data/catalog.json\`.
3.  Hacer doble-clic sobre \`iniciar_bot_vps_windows.bat\` y escanear el Código QR directamente desde la pantalla de consola negra.

---
*Desarrollado y optimizado exhaustivamente con los mas altos estandares de desarrollo IA y software para operar 24/7 en alta demanda.*
