// LinceTutores · transporte Gmail centralizado (no guarda secretos).
'use strict';
const nodemailer = require('nodemailer');

function configurado() {
  const email=String(process.env.GMAIL_USER||'').trim();
  const pass=String(process.env.GMAIL_APP_PASSWORD||'').replace(/\s/g,'');
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    && !email.includes('tu_cuenta@') && !email.includes('correo_de_')
    && pass.length>=16 && !/PEGA_AQUI|CAMBIAR|EJEMPLO|TU_CLAVE/i.test(pass);
}
function crearTransporte() {
  if (!configurado()) throw new Error('Configura GMAIL_USER y GMAIL_APP_PASSWORD en server/.env');
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER.trim(),
      pass: process.env.GMAIL_APP_PASSWORD.replace(/\s/g, '')
    },
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 20000
  });
}
async function enviarCorreo({ to, subject, text }) {
  if (!configurado()) throw new Error('Gmail sin configurar');
  if (!to || !subject || !text) throw new Error('Correo incompleto');
  const transporte=crearTransporte();
  try {
    return await transporte.sendMail({
      from: { name: 'LinceTutores', address: process.env.GMAIL_USER.trim() },
      to, subject, text
    });
  } finally { transporte.close(); }
}
module.exports={ configurado, crearTransporte, enviarCorreo };
