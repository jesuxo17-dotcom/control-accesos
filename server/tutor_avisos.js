// LinceTutores: cola persistente para correos automáticos de ingreso y salida.
// El escaneo NO espera la respuesta de Gmail.
'use strict';
const { configurado, enviarCorreo } = require('./gmail');
const { fechaLocal } = require('./fecha');

function crearGestorAvisos(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS tutores_envios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id INTEGER NOT NULL REFERENCES eventos(id),
    tutor_id INTEGER NOT NULL REFERENCES tutores_cuentas(id),
    canal TEXT NOT NULL CHECK (canal IN ('email','whatsapp')),
    destinatario TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','enviado','error')),
    intentos INTEGER NOT NULL DEFAULT 0,
    reintentar_epoch INTEGER NOT NULL DEFAULT 0,
    ultimo_error TEXT,
    fecha_hora TEXT NOT NULL,
    enviado_en TEXT,
    UNIQUE(evento_id,tutor_id,canal)
  );
  CREATE INDEX IF NOT EXISTS ix_tutores_envios_pendientes ON tutores_envios(canal,estado,reintentar_epoch);`);
  // Compatibilidad: si un proyecto anterior aún no tenía modo demo, creamos su tabla.
  db.exec(`CREATE TABLE IF NOT EXISTS tutores_demo_eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tutor_id INTEGER NOT NULL REFERENCES tutores_cuentas(id),
    hijo_id INTEGER NOT NULL REFERENCES tutores_hijos(id),
    tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','egreso')),
    fecha_hora TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_tutores_demo_eventos_tutor ON tutores_demo_eventos(tutor_id,id);`);
  // Cola separada: avisos ficticios del modo DEMOSTRACIÓN, nunca de eventos reales.
  db.exec(`CREATE TABLE IF NOT EXISTS tutores_demo_envios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id INTEGER NOT NULL REFERENCES tutores_demo_eventos(id),
    tutor_id INTEGER NOT NULL REFERENCES tutores_cuentas(id),
    destinatario TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','enviado','error')),
    intentos INTEGER NOT NULL DEFAULT 0,
    reintentar_epoch INTEGER NOT NULL DEFAULT 0,
    ultimo_error TEXT,
    fecha_hora TEXT NOT NULL,
    enviado_en TEXT,
    UNIQUE(evento_id,tutor_id)
  );
  CREATE INDEX IF NOT EXISTS ix_tutores_demo_envios_estado ON tutores_demo_envios(estado,reintentar_epoch);`);
  const demoDestinatario = db.prepare(`SELECT t.email
    FROM tutores_demo_eventos d
    JOIN tutores_hijos h ON h.id=d.hijo_id AND h.tutor_id=d.tutor_id
    JOIN tutores_cuentas t ON t.id=d.tutor_id
    WHERE d.id=? AND d.tutor_id=? AND d.hijo_id=? AND h.estado!='aprobada'
      AND t.avisos_permitidos=1 AND t.avisos_email=1 AND t.email_verificado=1
      AND t.email IS NOT NULL AND t.email NOT LIKE '%@example.com'
      AND t.email NOT LIKE '%@example.net' AND t.email NOT LIKE '%@example.org'`);
  const insertarDemo = db.prepare(`INSERT OR IGNORE INTO tutores_demo_envios
    (evento_id,tutor_id,destinatario,fecha_hora) VALUES (?,?,?,?)`);
  function prepararDemo(eventoId,tutorId,hijoId) {
    if (![eventoId,tutorId,hijoId].every(Number.isSafeInteger)) return false;
    const cuenta = demoDestinatario.get(eventoId,tutorId,hijoId);
    if (!cuenta?.email) return false;
    insertarDemo.run(eventoId,tutorId,cuenta.email,fechaLocal());
    setImmediate(()=>procesarCorreos().catch(e=>console.error('Correo demo:',e.message)));
    return true;
  }
  const tutores = db.prepare(`SELECT DISTINCT t.id,t.email,t.email_verificado,t.telefono,
    t.avisos_email
    FROM tutores_hijos h JOIN tutores_cuentas t ON t.id=h.tutor_id
    WHERE h.estado='aprobada' AND h.usuario_id=? AND t.avisos_permitidos=1`);
  const insert = db.prepare(`INSERT OR IGNORE INTO tutores_envios
    (evento_id,tutor_id,canal,destinatario,fecha_hora) VALUES (?,?,?,?,?)`);
  const preparar = db.transaction((eventoId,usuarioId) => {
    if(!Number.isSafeInteger(eventoId) || !Number.isSafeInteger(usuarioId)) return;
    for(const t of tutores.all(usuarioId)) {
      if(t.avisos_email && t.email_verificado && t.email && !/@example\.(com|net|org)$/i.test(t.email))
        insert.run(eventoId,t.id,'email',t.email,fechaLocal());
    }
  });
  const pendientesEmail=db.prepare(`SELECT n.id,n.destinatario,e.tipo,e.fecha_hora,e.kiosco_id,u.nombre
    FROM tutores_envios n
    JOIN eventos e ON e.id=n.evento_id JOIN usuarios u ON u.id=e.usuario_id
    JOIN tutores_cuentas t ON t.id=n.tutor_id
    JOIN tutores_hijos h ON h.tutor_id=t.id AND h.usuario_id=e.usuario_id AND h.estado='aprobada'
    WHERE n.canal='email' AND n.estado='pendiente' AND n.intentos<4 AND n.reintentar_epoch<=?
    AND t.avisos_permitidos=1 AND t.avisos_email=1 AND t.email_verificado=1 AND t.email=n.destinatario
    GROUP BY n.id ORDER BY n.id LIMIT 8`);
  const pendientesDemoEmail=db.prepare(`SELECT n.id,n.destinatario,d.tipo,d.fecha_hora,h.alumno_nombre AS nombre
    FROM tutores_demo_envios n
    JOIN tutores_demo_eventos d ON d.id=n.evento_id AND d.tutor_id=n.tutor_id
    JOIN tutores_hijos h ON h.id=d.hijo_id AND h.tutor_id=n.tutor_id AND h.estado!='aprobada'
    JOIN tutores_cuentas t ON t.id=n.tutor_id
    WHERE n.estado='pendiente' AND n.intentos<4 AND n.reintentar_epoch<=?
    AND t.avisos_permitidos=1 AND t.avisos_email=1 AND t.email_verificado=1
    AND t.email=n.destinatario
    ORDER BY n.id LIMIT 8`);
  const exitoDemo=db.prepare("UPDATE tutores_demo_envios SET estado='enviado',enviado_en=?,ultimo_error=NULL WHERE id=?");
  const falloDemo=db.prepare("UPDATE tutores_demo_envios SET intentos=intentos+1,estado=CASE WHEN intentos+1>=4 THEN 'error' ELSE 'pendiente' END,reintentar_epoch=?,ultimo_error=? WHERE id=?");
  const exito=db.prepare("UPDATE tutores_envios SET estado='enviado',enviado_en=?,ultimo_error=NULL WHERE id=?");
  const fallo=db.prepare("UPDATE tutores_envios SET intentos=intentos+1,estado=CASE WHEN intentos+1>=4 THEN 'error' ELSE 'pendiente' END,reintentar_epoch=?,ultimo_error=? WHERE id=?");
  let trabajando=false;
  async function procesarCorreos(){
    if(trabajando || !configurado()) return;
    trabajando=true;
    try {
      const ahora = Math.floor(Date.now()/1000);
      const trabajos = [
        ...pendientesEmail.all(ahora).map(e=>({...e,demo:false})),
        ...pendientesDemoEmail.all(ahora).map(e=>({...e,demo:true}))
      ];
      for(const e of trabajos) {
        try {
          const verbo = e.tipo==='ingreso'?'entró':'salió';
          // Movimientos reales: el mismo formato que el correo al usuario (datos tal como están en la BD)
          const real = e.demo ? null : require('./notificaciones').componerCorreo(e, 'tutor');
          await enviarCorreo(real ? { to:e.destinatario, ...real } : {
            to:e.destinatario,
            subject:e.demo
              ? `LinceTutores · SIMULACIÓN: ${e.tipo==='ingreso'?'entrada':'salida'}`
              : `LinceTutores · ${e.tipo==='ingreso'?'entrada':'salida'} registrada`,
            text:e.demo
              ? `SIMULACIÓN / PRUEBA — NO ES UN MOVIMIENTO REAL.\n\nEn LinceTutores, ${e.nombre} ${verbo} a la universidad el ${e.fecha_hora} (hora de Mazatlán).\n\nEsta notificación fue generada usando el modo de demostración; no representa una entrada o salida real.`
              : `Aviso de LinceTutores: ${e.nombre} ${verbo} a la universidad el ${e.fecha_hora} (hora de Mazatlán).`
          });
          (e.demo?exitoDemo:exito).run(fechaLocal(),e.id);
        } catch(err){
          console.warn('Correo LinceTutores:',String(err.message).slice(0,200));
          const tabla = e.demo?'tutores_demo_envios':'tutores_envios';
          const intentos=db.prepare(`SELECT intentos FROM ${tabla} WHERE id=?`).get(e.id).intentos;
          (e.demo?falloDemo:fallo).run(ahora+Math.min(3600,60*2**intentos),String(err.message).slice(0,200),e.id);
        }
      }
    } finally {trabajando=false;}
  }
  const intervalo=setInterval(()=>procesarCorreos().catch(console.error),15000);
  intervalo.unref();
  setImmediate(()=>procesarCorreos().catch(console.error));

  return {
    preparar(eventoId,usuarioId) {
      const resultado=preparar(eventoId,usuarioId);
      setImmediate(()=>procesarCorreos().catch(e=>console.error('Correo real:',e.message)));
      return resultado;
    },
    prepararDemo, procesarCorreos
  };
}
module.exports=crearGestorAvisos;
