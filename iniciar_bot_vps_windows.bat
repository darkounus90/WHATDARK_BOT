@echo off
title Iniciador del Bot de WhatsApp
echo ========================================================
echo   Ejecutor Inteligente del Bot (Para VPS Windows)
echo ========================================================
echo.

IF NOT EXIST "node_modules\" (
    echo [*] Primera ejecucion detectada. 
    echo Procediendo a instalar dependencias por primera vez...
    call npm install
    echo.
    
    echo [*] Compilando el codigo...
    call npm run build
    echo.
) ELSE (
    echo [*] Todo esta instalado, arrancando directamente.
    echo.
)

echo [*] Iniciando el Bot de WhatsApp...
echo Intentando iniciar con PM2...
call pm2 start dist/app.js --name "whatsapp-bot" >nul 2>&1

echo.
echo Si ves que la consola se detiene aqui, el bot arrancara en esta ventana:
node dist/app.js

pause
