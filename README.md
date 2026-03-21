# AI Bot para Ecommerce (WhatsApp)

Bot conversacional impulsado por OpenAI (`gpt-4o-mini`) y `whatsapp-web.js` para automatizar la atención al cliente y ventas en tiendas virtuales.

## Requisitos
- Node.js (v18 o superior recomendado)
- Una clave API de OpenAI con créditos disponibles.

## Instrucciones para levantar el proyecto localmente

1. **Abre tu terminal** y navega a la carpeta del proyecto:
   ```bash
   cd C:\Users\PC\Documents\WhatsappBOT\ecommerce-bot
   ```

2. **Instala las dependencias**:
   ```bash
   npm install
   ```

3. **Configura las variables de entorno**:
   Abre el archivo `.env.example`, cópialo y renómbralo a `.env`. (O simplemente edita el existente y guárdalo como `.env`).
   Asegúrate de agregar tu `OPENAI_API_KEY`:
   ```bash
   OPENAI_API_KEY=tu_clave_real_aqui_sk-...
   STORE_NAME="Mi Tienda Online"
   ```

4. **Inicia el Bot en modo desarrollo**:
   ```bash
   npm run dev
   ```

5. **Escanea el Código QR**:
   En la terminal aparecerá un código QR tras unos segundos. Abre WhatsApp en tu celular > Dispositivos vinculados > Vincular un dispositivo. Escanea este QR. 
   Una vez escaneado, la terminal dirá "¡Cliente de WhatsApp conectado y listo...!"

## Pruebas Manuales
Para probar el bot, escríbele un mensaje desde OTRO número de WhatsApp hacia el número que vinculaste.
Puedes probar el catálogo y los pedidos editando `src/data/catalog.json` y `src/data/orders.json`.
Asegúrate de probar los 10 escenarios propuestos en el plan de implementación.

## Despliegue Básico (Deploy en Producción)

Dado que `whatsapp-web.js` ejecuta una instancia de Chromium, no se puede desplegar fácilmente en Serverless (Vercel/Netlify). La mejor opción es un VPS.

1. **VPS (Ubuntu en DigitalOcean, AWS EC2, Linode)**:
   - Instala Node.js, `npm` y Git en el VPS.
   - Instala dependencias para Chromium: `sudo apt install -y gconf-service libgbm-dev libasound2 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates fonts-liberation libnss3 lsb-release xdg-utils wget.

2. **Sube tu código y compila**:
   ```bash
   npm install
   npm run build
   ```

3. **Ejecuta con PM2 (Manejo de procesos continuos)**:
   ```bash
   npm install -g pm2
   pm2 start dist/app.js --name "whatsapp-bot"
   ```
   Con PM2 el bot se mantendrá activo 24/7 incluso si cierras la terminal SSH.
