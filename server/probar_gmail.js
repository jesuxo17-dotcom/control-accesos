// Prueba Gmail SIN enviar un correo a terceras personas.
'use strict';
const path = require('node:path');
require('dotenv').config({path:path.join(__dirname,'.env')});
const {configurado,crearTransporte,enviarCorreo}=require('./gmail');
(async()=>{
  if(!configurado()) {
    console.error('FALTA CONFIGURACIÓN: abre server/.env y completa GMAIL_USER y GMAIL_APP_PASSWORD.');
    process.exitCode=1;return;
  }
  const transporte=crearTransporte();
  try {
    await transporte.verify();
    console.log('OK: Gmail aceptó la autenticación SMTP.');
    if(process.argv.includes('--enviar')) {
      await enviarCorreo({to:process.env.GMAIL_USER.trim(),subject:'LinceTutores · prueba Gmail',
        text:'¡La conexión Gmail de LinceTutores funciona! Este es un mensaje de prueba enviado solo a tu propia cuenta.'});
      console.log('Correo de prueba enviado a la propia cuenta configurada. Revisa Recibidos y Spam.');
    } else {
      console.log('Para enviar una prueba a tu propia cuenta: node probar_gmail.js --enviar');
    }
  } catch(e){
    console.error('No se pudo conectar a Gmail:',String(e.message).slice(0,250));
    process.exitCode=1;
  } finally {transporte.close();}
})();
