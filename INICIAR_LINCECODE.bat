@echo off
rem =====================================================================
rem  INICIAR_LINCECODE.bat - Enciende todo con doble clic:
rem   1) El servidor (panel, kiosco, app de tutores y base de datos)
rem   2) El tunel de Cloudflare (enlace https para celulares y fuera de tu red)
rem  Deja abiertas las dos ventanas negras: si las cierras, se apaga.
rem =====================================================================
cd /d "%~dp0server"

echo Encendiendo el servidor LinceCode...
start "Servidor LinceCode (no cerrar)" cmd /k "node server.js"

rem Espera unos segundos a que el servidor arranque
timeout /t 4 /nobreak >nul

echo Abriendo el panel en el navegador...
start "" "http://localhost:3000/dashboard/"

echo Encendiendo el tunel de Cloudflare (necesita internet)...
start "Tunel Cloudflare (no cerrar) - busca la linea https://....trycloudflare.com" "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000

echo.
echo Listo. En la ventana "Tunel Cloudflare" aparece tu enlace nuevo:
echo   https://algo-algo.trycloudflare.com
echo Agregale /dashboard/  /kiosco/  o  /tutores/  al final.
echo.
pause
