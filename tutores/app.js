// LinceTutores · sin frameworks. Los datos reales se guardan en SQLite del servidor.
'use strict';
const $=id=>document.getElementById(id);
const vistas=['Carga','Bienvenida','Registro','Inicio','Hijos','Agregar','Hijo','Historial','Cuenta'];
const estado={cuenta:null,hijos:[],hijo:null,vista:'carga',preferencias:null};
let timeoutMensaje;
function aviso(mensaje,error=false){
  const el=$('mensaje');el.textContent=mensaje;el.classList.toggle('bad',error);el.classList.remove('hide');
  clearTimeout(timeoutMensaje);timeoutMensaje=setTimeout(()=>el.classList.add('hide'),5000);
}
async function api(url,options={}) {
  const res=await fetch('/api/tutores'+url,{credentials:'same-origin',headers:{'Content-Type':'application/json'},cache:'no-store',...options});
  let data;try{data=await res.json();}catch{data={};}
  if(!res.ok)throw new Error(data.error||'No se pudo completar la solicitud.');
  return data;
}
function mostrar(pagina){
  estado.vista=pagina;
  for(const v of vistas)$('vista'+v).classList.toggle('hide',v.toLowerCase()!==pagina);
  const dentro=['inicio','hijos','agregar','hijo','historial','cuenta'].includes(pagina);
  $('barraAbajo').classList.toggle('hide',!dentro);
  $('btnLogout').classList.toggle('hide',!dentro);
  const tabActivo = ['agregar','hijo'].includes(pagina) ? 'hijos' : pagina;
  for(const b of document.querySelectorAll('[data-nav]')) {
    const activo=b.dataset.nav===tabActivo;
    b.classList.toggle('selected',activo);
    if(activo)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');
  }
  window.scrollTo({top:0,behavior:'instant'});
}
function fechaBonita(fecha){
  // SQLite almacena fecha local YYYY-MM-DD HH:mm:ss; se muestra sin cambiar de huso.
  if(typeof fecha!=='string'||fecha.length<16)return 'Sin hora';
  return `${fecha.slice(8,10)}/${fecha.slice(5,7)}/${fecha.slice(0,4)} · ${fecha.slice(11,16)}`;
}
function chip(texto,clase='dim'){
  const span=document.createElement('span');span.className='pill '+clase;span.textContent=texto;return span;
}
function empty(texto){const p=document.createElement('p');p.className='muted small center';p.textContent=texto;return p;}
function filaMovimiento(m,conNombre=false){
  const fila=document.createElement('div');fila.className='history-row';
  const lado=document.createElement('div');const t=document.createElement('div');
  t.className='type '+(m.tipo==='ingreso'?'in':'out');
  t.textContent=(m.tipo==='ingreso'?'↪ Ingresó':'↩ Salió')+(conNombre?' · '+m.nombre:'')+(m.simulado?' · SIMULACIÓN':'');
  lado.append(t);fila.append(lado);
  const fecha=document.createElement('span');fecha.className='date';fecha.textContent=fechaBonita(m.fecha_hora);fila.append(fecha);
  return fila;
}
async function cargarHijos(){
  const data=await api('/hijos');estado.hijos=data.hijos||[];
  // Las cuentas no aprobadas muestran únicamente los últimos movimientos FICTICIOS.
  let demo=[];
  try{demo=(await api('/demo/avisos')).avisos||[];}catch(e){console.warn('Demo:',e.message);}
  const ultimoDemoPorHijo=new Map();
  for(const e of demo)if(!ultimoDemoPorHijo.has(e.hijo_id))ultimoDemoPorHijo.set(e.hijo_id,e);
  $('contadorHijos').textContent=String(estado.hijos.length);
  $('resumenHijos').textContent=String(estado.hijos.length);
  const lista=$('listaHijos');lista.replaceChildren();
  if(!estado.hijos.length)lista.append(empty('Todavía no has agregado hijos.'));
  for(const h of estado.hijos){
    const boton=document.createElement('button');boton.type='button';boton.className='child-card';
    const icono=document.createElement('div');icono.className='hat';icono.textContent='🎓';
    const content=document.createElement('div');content.className='content';
    const nombre=document.createElement('strong');nombre.textContent=h.nombre||('Alumno con matrícula '+h.matricula);
    const mat=document.createElement('div');mat.className='small muted';mat.textContent=h.matricula?'Matrícula: '+h.matricula:'Matrícula: la confirma el plantel';
    content.append(nombre,mat);
    let estadoHijo;
    if(h.estado==='pendiente' || h.estado==='rechazada'){
      estadoHijo=chip('✓ Registrado','ok');
    }
    else if(h.ultimo_movimiento)estadoHijo=chip(`${h.ultimo_movimiento.tipo==='ingreso'?'↪ Ingresó':'↩ Salió'} · ${fechaBonita(h.ultimo_movimiento.fecha_hora)}`,h.ultimo_movimiento.tipo==='ingreso'?'ok':'exit');
    else estadoHijo=chip('Sin movimientos','dim');
    content.append(estadoHijo);
    const arrow=document.createElement('span');arrow.className='arrow';arrow.textContent='›';
    boton.append(icono,content,arrow);
    boton.addEventListener('click',()=>abrirHijo(h.id));lista.append(boton);
  }
}
async function abrirHijo(id){
  const h=estado.hijos.find(x=>x.id===id);if(!h)return;
  estado.hijo=h;$('detalleNombre').textContent=h.nombre||('Alumno con matrícula '+h.matricula);$('detalleMatricula').textContent=h.matricula?'Matrícula: '+h.matricula:'Matrícula: la confirma el plantel';
  const estadoEl=$('detalleEstado');estadoEl.replaceChildren(chip(h.estado==='aprobada'?'✓ Vinculación real autorizada':'✓ Registrado','ok'));
  $('panelDemoMovimientos').classList.toggle('hide',h.estado==='aprobada');
  const form=$('formEmergencia');form.elements.nombre.value=h.emergencia_nombre||'';
  form.elements.parentesco.value=h.emergencia_parentesco||'';
  form.elements.telefono.value=h.emergencia_telefono||'';
  const lista=$('listaMovimientos');lista.replaceChildren();
  if(h.estado==='aprobada'){
    try{
      const data=await api('/hijos/'+h.id+'/movimientos');
      if(!data.movimientos.length)lista.append(empty('Este hijo todavía no tiene movimientos registrados.'));
      for(const mov of data.movimientos)lista.append(filaMovimiento(mov));
    }catch(e){lista.append(empty(e.message));}
  }else {
    try{
      const data=await api('/demo/hijos/'+h.id+'/movimientos');
      if(!data.movimientos.length)lista.append(empty('Todavía no hay movimientos simulados. Usa los botones de demostración.'));
      for(const mov of data.movimientos)lista.append(filaMovimiento(mov));
    }catch(e){lista.append(empty(e.message));}
  }
  mostrar('hijo');
}
async function cargarAvisos(){
  const l=$('listaAvisos');l.replaceChildren();
  try{
    const [reales,demo]=await Promise.all([api('/avisos'),api('/demo/avisos')]);
    const items=[...(reales.avisos||[]),...(demo.avisos||[])];
    items.sort((a,b)=>b.fecha_hora.localeCompare(a.fecha_hora)||Number(b.simulado)-Number(a.simulado)||b.id-a.id);
    if(!items.length)l.append(empty('Todavía no hay avisos. Puedes crear entradas y salidas simuladas para probar la app.'));
    for(const a of items)l.append(filaMovimiento(a,true));
  }catch(e){l.append(empty(e.message));}
}
async function ir(pagina){
  if(pagina==='inicio'||pagina==='hijos')await cargarHijos();
  if(pagina==='historial')await cargarAvisos();
  if(pagina==='cuenta'&&estado.cuenta){$('cuentaNombre').textContent=estado.cuenta.nombre;$('cuentaTelefono').textContent='Teléfono: +'+estado.cuenta.telefono;await cargarPreferencias();}
  mostrar(pagina);
}
async function iniciar(){
  mostrar('carga');
  try{
    const data=await api('/cuenta');estado.cuenta=data.cuenta;
    $('saludoNombre').textContent='Hola, '+estado.cuenta.nombre.split(' ')[0];
    await ir('inicio');
    configSonidos.ultimoEvento=null; demoSonidos.ultimo=null; await revisarAvisosSonoros(); await revisarAvisosDemo();
  }catch{mostrar('bienvenida');}
}
function manejar(form,fn){form.addEventListener('submit',async ev=>{ev.preventDefault();const btn=form.querySelector('[type=submit]');btn.disabled=true;try{await fn(new FormData(form));}catch(e){aviso(e.message,true);}finally{btn.disabled=false;}});}
manejar($('formRegistro'),async d=>{
  const pass=d.get('password');if(pass!==d.get('confirmar'))throw new Error('Las contraseñas no coinciden.');
  await api('/registro',{method:'POST',body:JSON.stringify({nombre:d.get('nombre'),telefono:d.get('telefono'),password:pass})});
  const registroEmail=String(d.get('email')||'').trim();$('formRegistro').reset();aviso('Cuenta creada correctamente.');await iniciar();if(registroEmail){try{await api('/preferencias',{method:'PUT',body:JSON.stringify({email:registroEmail,avisos_permitidos:false,avisos_email:false,avisos_push:false})});}catch(e){console.warn('Correo pendiente:',e.message);}}
});
manejar($('formLogin'),async d=>{
  await api('/login',{method:'POST',body:JSON.stringify({telefono:d.get('telefono'),password:d.get('password')})});
  $('formLogin').reset();await iniciar();
});
manejar($('formHijo'),async d=>{
  const nombreHijo=String(d.get('nombre')||'').trim(), matriculaHijo=String(d.get('matricula')||'').trim();
  if(!nombreHijo&&!matriculaHijo)throw new Error('Escribe el nombre completo de tu hijo o su matrícula.');
  await api('/hijos',{method:'POST',body:JSON.stringify({nombre:nombreHijo,matricula:matriculaHijo})});
  $('formHijo').reset();aviso('Hijo registrado correctamente. Puedes consultar sus datos en Mis hijos.');await ir('hijos');
});
manejar($('formEmergencia'),async d=>{
  if(!estado.hijo)throw new Error('Selecciona un hijo.');
  await api('/hijos/'+estado.hijo.id+'/emergencia',{method:'PUT',body:JSON.stringify({nombre:d.get('nombre'),parentesco:d.get('parentesco'),telefono:d.get('telefono')})});
  aviso('Contacto de emergencia guardado en SQLite.');await cargarHijos();
  const h=estado.hijos.find(x=>x.id===estado.hijo.id);if(h)estado.hijo=h;
});
for(const [id,tipo] of [['btnDemoIngreso','ingreso'],['btnDemoEgreso','egreso']]){
  $(id).addEventListener('click',async()=>{
    if(!estado.hijo)return aviso('Primero selecciona un hijo.',true);
    const boton=$(id);boton.disabled=true;
    try{
      await api('/demo/hijos/'+estado.hijo.id+'/movimientos',{
        method:'POST',body:JSON.stringify({tipo})
      });
      await cargarHijos();
      await abrirHijo(estado.hijo.id);
      aviso('Movimiento de '+(tipo==='ingreso'?'entrada':'salida')+' SIMULADO guardado. Se verá en la app y, si activaste Gmail y verificaste tu correo, recibirás un aviso marcado como SIMULACIÓN.');
    }catch(e){aviso(e.message,true);}finally{boton.disabled=false;}
  });
}
$('abrirRegistro').addEventListener('click',()=>mostrar('registro'));
$('btnAgregarHijo').addEventListener('click',()=>mostrar('agregar'));
for(const b of document.querySelectorAll('[data-go]'))b.addEventListener('click',()=>ir(b.dataset.go).catch(e=>aviso(e.message,true)));
for(const b of document.querySelectorAll('[data-nav]'))b.addEventListener('click',()=>ir(b.dataset.nav).catch(e=>aviso(e.message,true)));
async function logout(){try{await api('/logout',{method:'POST',body:'{}'});}catch{}estado.cuenta=null;estado.hijos=[];configSonidos.ultimoEvento=null;demoSonidos.ultimo=null;mostrar('bienvenida');}
$('btnLogout').addEventListener('click',logout);$('cerrarSesionCuenta').addEventListener('click',logout);
function urlToBytes(b64){const pad='='.repeat((4-b64.length%4)%4);const data=atob((b64+pad).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(data,c=>c.charCodeAt(0));}
async function cargarPreferencias(){
  const r=await api('/preferencias'); const x=r.preferencias; estado.preferencias=x;
  const form=$('formPreferencias');
  form.elements.email.value=x.email||'';
  for(const k of ['avisos_permitidos','avisos_email','avisos_push'])form.elements[k].checked=Boolean(x[k]);
  $('correoVerificado').textContent=x.email_verificado?'✓ Correo verificado':'Correo pendiente de verificación';
}
manejar($('formPreferencias'),async d=>{
  const payload={email:String(d.get('email')||'').trim()};
  for(const k of ['avisos_permitidos','avisos_email','avisos_push'])payload[k]=d.get(k)==='on';
  await api('/preferencias',{method:'PUT',body:JSON.stringify(payload)});
  await cargarPreferencias(); aviso('Preferencias guardadas. Se respetarán en los siguientes avisos.');
});
$('btnCodigoCorreo').addEventListener('click',async()=>{
  try{await api('/correo/codigo',{method:'POST',body:'{}'});aviso('Revisa tu correo. El código vence en 10 minutos.');}
  catch(e){aviso(e.message,true);}
});
$('btnVerificarCorreo').addEventListener('click',async()=>{
  try{await api('/correo/verificar',{method:'POST',body:JSON.stringify({codigo:$('codigoCorreo').value.trim()})});
    $('codigoCorreo').value=''; await cargarPreferencias(); aviso('Correo verificado.');}
  catch(e){aviso(e.message,true);}
});
$('btnActivarPush').addEventListener('click',async()=>{
  if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))return aviso('Este navegador no admite notificaciones web.',true);
  if(!window.isSecureContext)return aviso('Para recibir avisos en el celular necesitas HTTPS.',true);
  try{
    if(!estado.preferencias?.avisos_permitidos||!estado.preferencias?.avisos_push)throw new Error('Primero habilita los avisos y la opción Celular en Mi cuenta.');
    const cfg=await api('/config-push');
    if(!cfg.disponible)throw new Error('Faltan las claves VAPID del servidor. Consulta al administrador.');
    const permiso=await Notification.requestPermission();
    if(permiso!=='granted')throw new Error('No autorizaste las notificaciones.');
    const reg=await navigator.serviceWorker.ready;
    let sus=await reg.pushManager.getSubscription();
    if(!sus)sus=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlToBytes(cfg.clave_publica)});
    await api('/suscripciones',{method:'POST',body:JSON.stringify(sus.toJSON())});
    $('estadoPush').textContent='Notificaciones activadas en este dispositivo. Solo se enviarán por hijos aprobados.';
    aviso('Avisos activados en este celular.');
  }catch(e){aviso(e.message,true);}
});
if('serviceWorker' in navigator&&window.isSecureContext){navigator.serviceWorker.register('/tutores/sw.js').catch(console.error);}
// Audio local para la app ABIERTA. Una PWA no puede elegir el tono de un push con la app cerrada.
const configSonidos={habilitados:localStorage.getItem('lince_tutores_sonidos')==='si',ultimoEvento:null,actualizando:false};
function pintarControlSonidos(){
  $('btnSonidos').textContent=configSonidos.habilitados?'🔕 Desactivar sonidos':'🔔 Activar sonidos';
  $('estadoSonido').textContent=configSonidos.habilitados
    ? 'Sonidos activados. Ingreso y salida tienen tonos diferentes cuando la app está abierta.'
    : 'Sonidos desactivados. Toca Activar para permitir audio en este dispositivo.';
}
async function reproducirSonido(tipo){
  const nombre=tipo==='ingreso'?'ingreso':'egreso';
  const audio=new Audio('/tutores/sounds/'+nombre+'.wav');
  audio.volume=0.8;
  await audio.play(); // El navegador puede impedir el audio antes de un gesto del tutor.
}
$('btnSonidos').addEventListener('click',async()=>{
  if(configSonidos.habilitados){
    configSonidos.habilitados=false;
    localStorage.setItem('lince_tutores_sonidos','no');
    pintarControlSonidos();aviso('Sonidos desactivados.');return;
  }
  try {
    // Un toque real en el botón desbloquea la reproducción en el navegador.
    await reproducirSonido('ingreso');
    configSonidos.habilitados=true;
    localStorage.setItem('lince_tutores_sonidos','si');
    pintarControlSonidos();aviso('Sonidos activados. Se escuchó el aviso de ingreso.');
  } catch(e) {
    configSonidos.habilitados=false;
    pintarControlSonidos();
    aviso('El navegador bloqueó el sonido. Revisa el volumen y vuelve a tocar Activar.',true);
  }
});
for(const [id,tipo] of [['btnProbarIngreso','ingreso'],['btnProbarEgreso','egreso']]){
  $(id).addEventListener('click',async()=>{
    try {await reproducirSonido(tipo);}catch(e){aviso('El navegador bloqueó el sonido de prueba.',true);}
  });
}
// Se consultan ÚNICAMENTE movimientos de hijos aprobados desde la sesión del tutor.
// Al entrar no se reproducen sonidos por el historial existente.
async function revisarAvisosSonoros(){
  if(!estado.cuenta||document.hidden||configSonidos.actualizando)return;
  configSonidos.actualizando=true;
  try {
    const {avisos=[]}=await api('/avisos');
    const ids=avisos.map(a=>Number(a.id)).filter(Number.isFinite);
    const ultimo=ids.length?Math.max(...ids):0;
    if(configSonidos.ultimoEvento===null){configSonidos.ultimoEvento=ultimo;return;}
    const nuevos=avisos.filter(a=>Number(a.id)>configSonidos.ultimoEvento)
      .sort((a,b)=>Number(a.id)-Number(b.id));
    configSonidos.ultimoEvento=Math.max(configSonidos.ultimoEvento,ultimo);
    if(!nuevos.length)return;
    for(const a of nuevos){
      // Mostrar avisos solo de hijos vinculados y aprobados; /avisos los filtra.
      const movimiento=a.tipo==='ingreso'?'ingresó':'salió';
      aviso(`${a.nombre} ${movimiento} · ${fechaBonita(a.fecha_hora)}`);
      if(configSonidos.habilitados && estado.preferencias?.avisos_permitidos){
        try{await reproducirSonido(a.tipo);}catch(e){console.warn('Sonido no permitido:',e.message);}
      }
    }
    if(estado.vista==='inicio'||estado.vista==='hijos')await cargarHijos();
    if(estado.vista==='historial')await cargarAvisos();
  }catch(e){console.warn('No se pudo consultar avisos:',e.message);}
  finally{configSonidos.actualizando=false;}
}
pintarControlSonidos();
// Primer sondeo establece la referencia: no anuncia movimientos antiguos.
setInterval(revisarAvisosSonoros, 8000);
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&estado.cuenta){
    // Al volver desde segundo plano el teléfono pudo haber usado una notificación push.
    // Actualizamos historial sin duplicar tono por los eventos ocurridos mientras estaba oculta.
    configSonidos.ultimoEvento=null;
    revisarAvisosSonoros();
  }
});

// Sondeos de la demo: funcionan entre navegador de laptop y celular con la misma cuenta.
// No leen ni transmiten movimientos reales de estudiantes sin autorización.
const demoSonidos={ultimo:null,actualizando:false};
async function revisarAvisosDemo(){
  if(!estado.cuenta||document.hidden||demoSonidos.actualizando)return;
  demoSonidos.actualizando=true;
  try{
    const {avisos=[]}=await api('/demo/avisos');
    const ultimo=avisos.length?Math.max(...avisos.map(a=>Number(a.id))):0;
    if(demoSonidos.ultimo===null){demoSonidos.ultimo=ultimo;return;}
    const nuevos=avisos.filter(a=>Number(a.id)>demoSonidos.ultimo).sort((a,b)=>a.id-b.id);
    demoSonidos.ultimo=Math.max(demoSonidos.ultimo,ultimo);
    for(const a of nuevos){
      aviso(`SIMULACIÓN: ${a.nombre} ${a.tipo==='ingreso'?'ingresó':'salió'} · ${fechaBonita(a.fecha_hora)}`);
      if(configSonidos.habilitados){try{await reproducirSonido(a.tipo);}catch{}}
    }
    if(nuevos.length){
      if(estado.vista==='inicio'||estado.vista==='hijos')await cargarHijos();
      if(estado.vista==='historial')await cargarAvisos();
      if(estado.vista==='hijo'&&estado.hijo)await abrirHijo(estado.hijo.id);
    }
  }catch(e){console.warn('Avisos demo:',e.message);}finally{demoSonidos.actualizando=false;}
}
setInterval(revisarAvisosDemo,8000);
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&estado.cuenta){demoSonidos.ultimo=null;revisarAvisosDemo();}
});
// Actualiza solo los movimientos autorizados mediante endpoints de la cuenta del tutor.
// Nunca recibe el canal Socket.IO general del kiosco (contiene datos de otros usuarios).
setInterval(async () => {
  if (!estado.cuenta || document.hidden) return;
  try {
    if (estado.vista === 'inicio') await cargarHijos();
    else if (estado.vista === 'historial') await cargarAvisos();
    else if (estado.vista === 'hijo' && estado.hijo) {
      const id = estado.hijo.id;
      await cargarHijos();
      await abrirHijo(id);
    }
  } catch (err) { console.warn('Actualización de avisos:', err.message); }
}, 15000);
iniciar();
