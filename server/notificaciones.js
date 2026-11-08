// Correo de entrada y salida; nunca retrasa la respuesta de /api/scan.
//
// La BASE DE DATOS es la única fuente de verdad:
//   - /api/scan identifica a la persona por su ID y guarda el evento (tipo, hora, kiosco).
//   - Aquí cada aviso se lee por evento_id -> eventos -> usuarios (por ID) en el momento
//     de enviarlo: nombre, correo, tipo, fecha_hora y kiosco salen de esas filas.
//   - Nada de nombres ni correos escritos en el código; la hora es la guardada en el
//     evento (America/Mazatlan), no la del momento del envío.
//
// Canales en la tabla notificaciones (sin cambiar su estructura):
//   'correo_usuario' -> al correo del propio usuario (usuarios.email)
//   'email'          -> al tutor (usuarios.tutor_email, solo si notificar_tutor = 1)
//
// Sin correo o con un correo inválido: el movimiento ya quedó guardado, el aviso se marca
// 'error' y se anota en el log (consola), sin tumbar nada.
// Modo de prueba: CORREO_PRUEBA=1 en .env escribe cada correo en server/logs/correos.log
// en lugar de enviarlo (para probar sin mandar correos reales).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fechaLocal } = require('./fecha');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Dominios reservados para ejemplos (los del seed): jamás se envían
const DOMINIO_EJEMPLO = /@(example\.(com|org|net)|[\w.-]+\.(invalid|test|example))$/i;
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** Revisa un correo de la base: null si sirve, o el motivo por el que no se envía */
function motivoCorreoInvalido(correo) {
  const c = String(correo || '').trim();
  if (!c) return 'sin correo registrado';
  if (!EMAIL.test(c)) return 'correo con formato inválido';
  if (DOMINIO_EJEMPLO.test(c)) return 'correo de ejemplo (no se envía)';
  return null;
}

/** 'YYYY-MM-DD HH:MM:SS' tal como está en eventos.fecha_hora -> partes legibles, sin cambiar de zona */
function partesFecha(fh) {
  const m = String(fh || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return { fecha: String(fh || ''), hora: '' };
  const [, y, mo, d, h, mi, s] = m;
  const dia = DIAS[new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay()];
  return { fecha: `${dia} ${+d} de ${MESES[+mo - 1]} de ${y}`, hora: `${h}:${mi}:${s}` };
}

/**
 * Arma el correo con los datos tal como quedaron en la base.
 * datos = { nombre, tipo: 'ingreso'|'egreso', fecha_hora, kiosco_id }, para = 'usuario' | 'tutor'
 */
function componerCorreo(datos, para = 'usuario') {
  const entrada = datos.tipo === 'ingreso';
  const movimiento = entrada ? 'Entrada' : 'Salida';
  const { fecha, hora } = partesFecha(datos.fecha_hora);
  const lugar = datos.kiosco_id ? `kiosco ${datos.kiosco_id}` : 'kiosco de acceso';
  const intro = para === 'tutor'
    ? `Aviso para el tutor de ${datos.nombre}: se registró su ${movimiento.toUpperCase()} en el Hackatón LinceCode 2026 de la UAdeO.`
    : `Hola, ${datos.nombre}:\n\nSe registró tu ${movimiento.toUpperCase()} en el Hackatón LinceCode 2026 de la UAdeO.`;
  return {
    subject: `${movimiento} registrada · ${datos.nombre} · LinceCode UAdeO`,
    text: `${intro}

Nombre:      ${datos.nombre}
Movimiento:  ${movimiento}
Fecha:       ${fecha}
Hora:        ${hora} (hora de Sinaloa)
Lugar:       ${lugar}

${para === 'tutor' ? 'Si tienes dudas, comunícate con el personal de seguridad del plantel.' : 'Si no fuiste tú, avisa de inmediato al personal de seguridad.'}
— Control de accesos LinceCode · Universidad Autónoma de Occidente`
  };
}

/** Envío real con el Gmail ya configurado (gmail.js) o, en modo de prueba, al archivo de log */
function enviadorPorDefecto() {
  const { configurado, enviarCorreo } = require('./gmail');
  return {
    listo: () => process.env.CORREO_PRUEBA === '1' || configurado(),
    async enviar(correo) {
      if (process.env.CORREO_PRUEBA === '1') {
        const dir = path.join(__dirname, 'logs');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, 'correos.log'),
          `--- ${fechaLocal()} (MODO PRUEBA, no enviado)\nPara: ${correo.to}\nAsunto: ${correo.subject}\n\n${correo.text}\n\n`);
        return;
      }
      await enviarCorreo(correo);
    }
  };
}

/**
 * opciones.enviador = { listo(): boolean, enviar({to, subject, text}) } (las pruebas pasan uno falso)
 * opciones.log = función para anotar avisos no enviados (por defecto console.warn)
 * opciones.automatico = false para no arrancar el ciclo de 15 s (pruebas)
 */
function crearNotificaciones(db, opciones = {}) {
  const enviador = opciones.enviador || enviadorPorDefecto();
  const log = opciones.log || ((...a) => console.warn('[correo]', ...a));
  let trabajando = false;

  // Todo por ID: evento -> usuario. Se lee en el momento del envío.
  const leer = db.prepare(`
    SELECT n.id, n.canal, e.id AS evento_id, e.tipo, e.fecha_hora, e.kiosco_id,
           u.id AS usuario_id, u.nombre, u.email, u.tutor_email, u.notificar_tutor
    FROM notificaciones n
    JOIN eventos e ON e.id = n.evento_id
    JOIN usuarios u ON u.id = e.usuario_id
    WHERE n.estado = 'pendiente' AND n.canal IN ('correo_usuario', 'email')
    ORDER BY n.id ASC LIMIT 20`);
  const estado = db.prepare('UPDATE notificaciones SET estado = ?, fecha_hora = ? WHERE id = ?');

  async function procesar() {
    if (trabajando || !enviador.listo()) return 0;
    trabajando = true;
    let enviados = 0;
    try {
      for (const item of leer.all()) {
        const paraTutor = item.canal === 'email';
        const destino = paraTutor ? item.tutor_email : item.email;
        const motivo = paraTutor && !item.notificar_tutor ? 'el tutor ya no tiene avisos activados' : motivoCorreoInvalido(destino);
        if (motivo) {
          estado.run('error', fechaLocal(), item.id);
          log(`No se envió el aviso del evento ${item.evento_id} (usuario ${item.usuario_id}, ${paraTutor ? 'tutor' : 'usuario'}): ${motivo}. El movimiento sí quedó guardado.`);
          continue;
        }
        try {
          await enviador.enviar({ to: String(destino).trim(), ...componerCorreo(item, paraTutor ? 'tutor' : 'usuario') });
          estado.run('enviado', fechaLocal(), item.id);
          enviados++;
        } catch (error) {
          estado.run('error', fechaLocal(), item.id);
          log(`Falló el envío del aviso del evento ${item.evento_id} (usuario ${item.usuario_id}): ${String(error.message).slice(0, 200)}`);
        }
      }
    } finally { trabajando = false; }
    return enviados;
  }
  if (opciones.automatico !== false) {
    // Las pendientes sobreviven si se reinicia el servidor.
    const intervalo = setInterval(() => procesar().catch(console.error), 15000);
    intervalo.unref();
    setImmediate(() => procesar().catch(console.error));
  }
  return procesar;
}
module.exports = crearNotificaciones;
module.exports.componerCorreo = componerCorreo;
module.exports.motivoCorreoInvalido = motivoCorreoInvalido;
