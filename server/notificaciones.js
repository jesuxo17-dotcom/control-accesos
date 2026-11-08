// Correo asíncrono para tutores; nunca retrasa la respuesta de /api/scan.
const nodemailer = require('nodemailer');
const { fechaLocal } = require('./fecha');
function crearNotificaciones(db) {
  let trabajando = false;
  const leer = db.prepare(`
    SELECT n.id, e.tipo, e.fecha_hora, u.nombre, u.tutor_email
    FROM notificaciones n
    JOIN eventos e ON e.id = n.evento_id
    JOIN usuarios u ON u.id = e.usuario_id
    WHERE n.estado = 'pendiente' AND n.canal = 'email'
    ORDER BY n.id ASC LIMIT 10`);
  const estado = db.prepare('UPDATE notificaciones SET estado = ?, fecha_hora = ? WHERE id = ?');
  async function procesar() {
    if (trabajando) return;
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return;
    trabajando = true;
    try {
      const transport = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
      });
      for (const item of leer.all()) {
        // Correos falsos del seed jamás se envían.
        if (!item.tutor_email || /@(example\.(com|org|net)|example\.invalid)$/i.test(item.tutor_email)) {
          estado.run('error', fechaLocal(), item.id);
          continue;
        }
        try {
          await transport.sendMail({
            from: process.env.GMAIL_USER,
            to: item.tutor_email,
            subject: `LinceCode: ${item.tipo} universitario`,
            text: `${item.nombre} registró ${item.tipo} el ${item.fecha_hora} (hora Mazatlán).`
          });
          estado.run('enviado', fechaLocal(), item.id);
        } catch (error) {
          console.error('Error enviando notificación:', error.message);
          estado.run('error', fechaLocal(), item.id);
        }
      }
    } finally { trabajando = false; }
  }
  // Las pendientes sobreviven si se reinicia el servidor.
  const intervalo = setInterval(() => procesar().catch(console.error), 15000);
  intervalo.unref();
  setImmediate(() => procesar().catch(console.error));
  return procesar;
}
module.exports = crearNotificaciones;
