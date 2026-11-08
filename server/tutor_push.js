// Web Push para los tutores autorizados: funciona aun con la PWA cerrada cuando el navegador lo permite.
// Se dispara al insertar un ingreso/egreso desde /api/scan, después de responder al kiosco.
'use strict';
const { fechaLocal } = require('./fecha');
function crearEnvioPush(db){
  let webpush=null;
  if(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY){
    try{
      webpush=require('web-push');
      webpush.setVapidDetails(process.env.VAPID_SUBJECT||'mailto:soporte@lincecode.invalid',process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
    }catch(err){console.warn('Push no configurado:',err.message);}
  }
  const suscripciones=db.prepare(`SELECT p.id,p.endpoint,p.p256dh,p.auth
    FROM tutores_push p JOIN tutores_hijos h ON h.tutor_id=p.tutor_id
    JOIN tutores_cuentas t ON t.id=p.tutor_id
    WHERE h.estado='aprobada' AND h.usuario_id=? AND t.avisos_permitidos=1 AND t.avisos_push=1`);
  const borrar=db.prepare('DELETE FROM tutores_push WHERE id=?');
  const registrar=db.prepare(`INSERT INTO notificaciones(evento_id,canal,estado,fecha_hora) VALUES(?,'push',?,?)`);
  return async function avisarTutoresPush(eventoId, usuarioId, tipo, fecha){
    if(!webpush) return;
    // Solo se muestra un aviso genérico en pantalla bloqueada.
    const titulo=tipo==='ingreso'?'Ingreso registrado':'Salida registrada';
    const body=`Movimiento a las ${String(fecha).slice(11,16)}. Abre LinceTutores para ver los detalles.`;
    const payload=JSON.stringify({titulo:`LinceCode · ${titulo}`,cuerpo:body,url:'/tutores/',evento_id:eventoId,tipo});
    const result=await Promise.allSettled(suscripciones.all(usuarioId).map(async s=>{
      try{
        await webpush.sendNotification({endpoint:s.endpoint,keys:{p256dh:s.p256dh,auth:s.auth}},payload,{TTL:3600});
        return true;
      }catch(e){if([404,410].includes(e.statusCode)) borrar.run(s.id);console.warn('Push:',e.statusCode||e.message);return false;}
    }));
    if(result.length) registrar.run(eventoId,result.some(x=>x.status==='fulfilled'&&x.value)?'enviado':'error',fechaLocal());
  };
}
module.exports=crearEnvioPush;
