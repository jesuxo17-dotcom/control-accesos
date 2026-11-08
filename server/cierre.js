// Cierra un día insertando egresos automáticos, SIN editar el historial.
const cron = require('node-cron');
const { fechaLocal, hoyLocal, diaAnterior } = require('./fecha');
function configurarCierre(db, io, obtenerAforo, programar = true) {
  // Quien sigue dentro al momento del cierre (último evento = ingreso, de
  // cualquier día) y NO tiene un permiso nocturno vigente en ese momento.
  // Los que tienen permiso se quedan dentro; si su permiso ya venció, el
  // siguiente cierre los atrapa (y ia.js avisa "permiso_vencido" mientras tanto).
  const ultimoDia = db.prepare(`
    WITH ultimo AS (
      SELECT usuario_id, tipo,
      ROW_NUMBER() OVER (PARTITION BY usuario_id ORDER BY fecha_hora DESC, id DESC) AS fila
      FROM eventos WHERE fecha_hora <= @cierre
    ) SELECT usuario_id FROM ultimo x
      WHERE fila = 1 AND tipo = 'ingreso'
        AND NOT EXISTS (SELECT 1 FROM permisos p
                        WHERE p.usuario_id = x.usuario_id AND p.desde <= @cierre AND p.hasta >= @cierre)`);
  const insertar = db.prepare(`
    INSERT INTO eventos (usuario_id, tipo, origen, kiosco_id, foto_captura, fecha_hora)
    VALUES (?, 'egreso', 'automatico', 'CIERRE', NULL, ?)`);
  function cerrarDia(dia = hoyLocal()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new Error('Día inválido');
    // Timestamp 23:59:59 del propio día; nunca se dejan eventos futuros del día siguiente.
    if (dia > hoyLocal()) throw new Error("No se puede cerrar un día futuro");
    const fechaCierre = dia === hoyLocal() ? fechaLocal() : `${dia} 23:59:59`;
    const trabajo = db.transaction(() => {
      const usuarios = ultimoDia.all({ cierre: fechaCierre });
      for (const u of usuarios) insertar.run(u.usuario_id, fechaCierre);
      return usuarios.length;
    });
    const cerrados = trabajo.immediate();
    if (cerrados) io.emit('aforo', obtenerAforo());
    return { cerrados };
  }
  // A las 00:00 cerramos EL DÍA ANTERIOR en hora local.
  if (programar) cron.schedule('0 0 * * *', () => {
    try { cerrarDia(diaAnterior(hoyLocal())); }
    catch (error) { console.error('Error en cierre automático:', error); }
  }, { timezone: 'America/Mazatlan' });
  return { cerrarDia };
}
module.exports = configurarCierre;
