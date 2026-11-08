// LinceCode 2026 · App Tutores. Las 6 tablas originales no se modifican.
// Registro, sesión persistente y vínculos de varios hijos con autorización del plantel.
'use strict';
const express = require('express');
const crypto = require('node:crypto');
const { exigirAdmin } = require('./seguridad');
const { fechaLocal, hoyLocal } = require('./fecha');

const normalizar = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
const claveNombre = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
// Hijo agregado solo con el nombre: su "matrícula" interna es SIN-<huella del nombre> (la app no la muestra)
const SIN_MATRICULA = /^SIN-/;
const nombreValido = s => typeof s === 'string' && s.trim().length >= 5 && s.trim().length <= 110 && /^[\p{L}\p{M}\s.'-]+$/u.test(s.trim());
const limpiarTelefono = v => {
  let s = String(v || '').replace(/\D/g, '');
  if (/^\d{10}$/.test(s)) s = '52' + s;
  return /^52\d{10}$/.test(s) ? s : null;
};
const matriculaValida = s => typeof s === 'string' && /^[A-Z0-9-]{3,30}$/.test(s.trim().toUpperCase());
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const clave = pwd => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pwd, salt, 32).toString('hex')}`;
};
function comprobarClave(pwd, almacenado) {
  const [alg, salt, hashHex] = String(almacenado || '').split('$');
  if (alg !== 'scrypt' || !/^[0-9a-f]{32}$/.test(salt || '') || !/^[0-9a-f]{64}$/.test(hashHex || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(hashHex, 'hex'), crypto.scryptSync(pwd, salt, 32));
}
function crearEsquemaTutores(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tutores_cuentas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      telefono TEXT NOT NULL UNIQUE,
      clave_hash TEXT NOT NULL,
      creada_en TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tutores_sesiones (
      token_hash TEXT PRIMARY KEY,
      tutor_id INTEGER NOT NULL REFERENCES tutores_cuentas(id),
      expira_epoch INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_tutores_sesiones ON tutores_sesiones(tutor_id);
    CREATE TABLE IF NOT EXISTS tutores_hijos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tutor_id INTEGER NOT NULL REFERENCES tutores_cuentas(id),
      alumno_nombre TEXT NOT NULL,
      matricula TEXT NOT NULL,
      usuario_id INTEGER REFERENCES usuarios(id),
      estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','aprobada','rechazada')),
      emergencia_nombre TEXT,
      emergencia_parentesco TEXT,
      emergencia_telefono TEXT,
      creada_en TEXT NOT NULL,
      actualizada_en TEXT NOT NULL,
      UNIQUE(tutor_id,matricula)
    );
    CREATE INDEX IF NOT EXISTS ix_tutores_hijos_usuario ON tutores_hijos(usuario_id,estado);
    CREATE TABLE IF NOT EXISTS tutores_push (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tutor_id INTEGER NOT NULL REFERENCES tutores_cuentas(id),
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      creada_en TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_tutores_push_cuenta ON tutores_push(tutor_id);
    -- Movimientos FICTICIOS de demostración; nunca se mezclan con eventos reales.
    CREATE TABLE IF NOT EXISTS tutores_demo_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tutor_id INTEGER NOT NULL REFERENCES tutores_cuentas(id),
      hijo_id INTEGER NOT NULL REFERENCES tutores_hijos(id),
      tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','egreso')),
      fecha_hora TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_tutores_demo_eventos_tutor
      ON tutores_demo_eventos(tutor_id,id);

  `);
  // Migración sin perder cuentas o eventos existentes.
  const columnas = new Set(db.pragma('table_info(tutores_cuentas)').map(c => c.name));
  const nuevas = {
    email: 'TEXT', email_verificado: 'INTEGER NOT NULL DEFAULT 0',
    email_codigo_hash: 'TEXT', email_codigo_hasta: 'INTEGER', email_codigo_intentos: 'INTEGER NOT NULL DEFAULT 0',
    email_codigo_ultimo: 'INTEGER NOT NULL DEFAULT 0',
    avisos_permitidos: 'INTEGER NOT NULL DEFAULT 0',
    avisos_email: 'INTEGER NOT NULL DEFAULT 0',
    avisos_whatsapp: 'INTEGER NOT NULL DEFAULT 0',
    avisos_push: 'INTEGER NOT NULL DEFAULT 0',
    telefono_verificado: 'INTEGER NOT NULL DEFAULT 0'
  };
  for(const [col,def] of Object.entries(nuevas)) if(!columnas.has(col)) db.exec(`ALTER TABLE tutores_cuentas ADD COLUMN ${col} ${def}`);
}
function crearRutasTutores(db) {
  crearEsquemaTutores(db);
  const router = express.Router();
  const cuentasPorTelefono = db.prepare('SELECT * FROM tutores_cuentas WHERE telefono=?');
  const cuentaPorId = db.prepare('SELECT id,nombre,telefono FROM tutores_cuentas WHERE id=?');
  const sesionPorToken = db.prepare(`SELECT s.tutor_id, s.expira_epoch FROM tutores_sesiones s WHERE s.token_hash=?`);
  const hijoPorId = db.prepare('SELECT * FROM tutores_hijos WHERE id=? AND tutor_id=?');
  const limites = new Map();
  function limitar(req,res,next) {
    const ip = req.ip || req.socket.remoteAddress || 'local';
    const now = Date.now();
    const anteriores = (limites.get(ip) || []).filter(t => now-t < 15*60*1000);
    if (anteriores.length >= 18) return res.status(429).json({error:'Demasiados intentos. Inténtalo más tarde.'});
    anteriores.push(now); limites.set(ip,anteriores);
    if (limites.size > 1500) limites.clear();
    next();
  }
  const cookieName = 'lince_tutor';
  function cookies(req) {
    const cabecera = String(req.headers.cookie || '');
    const m = cabecera.match(/(?:^|;\s*)lince_tutor=([a-f0-9]{64})(?:;|$)/);
    return m ? m[1] : null;
  }
  function crearSesion(res, tutorId, req) {
    const token = crypto.randomBytes(32).toString('hex');
    const segundos = 30*24*60*60;
    const expiry = Math.floor(Date.now()/1000) + segundos;
    db.prepare('INSERT INTO tutores_sesiones(token_hash,tutor_id,expira_epoch) VALUES(?,?,?)').run(hash(token),tutorId,expiry);
    const secure = req.secure || req.socket.encrypted;
    res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; Path=/api/tutores; SameSite=Strict; Max-Age=${segundos}${secure?'; Secure':''}`);
  }
  function exigirSesion(req,res,next) {
    const token = cookies(req);
    const s = token ? sesionPorToken.get(hash(token)) : null;
    if (!s || s.expira_epoch <= Math.floor(Date.now()/1000)) return res.status(401).json({error:'Inicia sesión para continuar.'});
    req.cuentaTutorId = s.tutor_id;
    next();
  }
  router.post('/registro', limitar, (req,res) => {
    const {nombre,password} = req.body || {};
    const telefono = limpiarTelefono(req.body?.telefono);
    if (!nombreValido(nombre) || !telefono || typeof password !== 'string' || password.length < 8 || password.length > 120) {
      return res.status(400).json({error:'Escribe nombre completo, teléfono válido y contraseña de al menos 8 caracteres.'});
    }
    if (cuentasPorTelefono.get(telefono)) return res.status(409).json({error:'Este teléfono ya tiene una cuenta. Inicia sesión.'});
    try {
      const r = db.prepare('INSERT INTO tutores_cuentas(nombre,telefono,clave_hash,creada_en) VALUES(?,?,?,?)')
        .run(nombre.trim(), telefono, clave(password), fechaLocal());
      crearSesion(res,Number(r.lastInsertRowid),req);
      res.status(201).json({registrado:true,cuenta:{id:Number(r.lastInsertRowid),nombre:nombre.trim(),telefono}});
    } catch { res.status(500).json({error:'No se pudo guardar la cuenta.'}); }
  });
  router.post('/login', limitar, (req,res) => {
    const telefono = limpiarTelefono(req.body?.telefono);
    const pass = String(req.body?.password || '');
    const cuenta = telefono ? cuentasPorTelefono.get(telefono) : null;
    const valido = cuenta ? comprobarClave(pass,cuenta.clave_hash) : false;
    if (!valido) return res.status(401).json({error:'Teléfono o contraseña incorrectos.'});
    crearSesion(res,cuenta.id,req);
    res.json({cuenta:{id:cuenta.id,nombre:cuenta.nombre,telefono:cuenta.telefono}});
  });
  router.post('/logout', exigirSesion, (req,res) => {
    const token=cookies(req);
    db.prepare('DELETE FROM tutores_sesiones WHERE token_hash=?').run(hash(token));
    res.setHeader('Set-Cookie',`${cookieName}=; HttpOnly; Path=/api/tutores; SameSite=Strict; Max-Age=0`);
    res.json({sesion_cerrada:true});
  });
  router.get('/cuenta', exigirSesion, (req,res) => {
    res.json({cuenta:cuentaPorId.get(req.cuentaTutorId)});
  });
  const leerPref=db.prepare(`SELECT email,email_verificado,telefono_verificado,
    avisos_permitidos,avisos_email,avisos_whatsapp,avisos_push
    FROM tutores_cuentas WHERE id=?`);
  router.get('/preferencias',exigirSesion,(req,res)=>res.json({preferencias:leerPref.get(req.cuentaTutorId)}));
  router.put('/preferencias',exigirSesion,(req,res)=>{
    const b=req.body||{};
    const email=String(b.email||'').trim().toLowerCase();
    if(email.length>160||(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))return res.status(400).json({error:'Correo electrónico inválido.'});
    for(const k of ['avisos_permitidos','avisos_email','avisos_push'])
      if(typeof b[k]!=='boolean')return res.status(400).json({error:'Selecciona las preferencias de aviso.'});
    const actual=leerPref.get(req.cuentaTutorId);
    const cambioEmail=email!==(actual.email||'');
    db.prepare(`UPDATE tutores_cuentas SET email=?,email_verificado=?,email_codigo_hash=NULL,
      email_codigo_hasta=NULL,email_codigo_intentos=0,
      avisos_permitidos=?,avisos_email=?,avisos_whatsapp=?,avisos_push=? WHERE id=?`)
      .run(email||null,cambioEmail?0:actual.email_verificado,
        Number(b.avisos_permitidos),Number(b.avisos_email),0,Number(b.avisos_push),req.cuentaTutorId);
    res.json({guardado:true,preferencias:leerPref.get(req.cuentaTutorId)});
  });
  // Verificar que el tutor realmente tiene acceso al correo antes de enviar movimientos privados.
  router.post('/correo/codigo',exigirSesion,limitar,async(req,res)=>{
    const c=db.prepare('SELECT email,email_verificado,email_codigo_ultimo FROM tutores_cuentas WHERE id=?').get(req.cuentaTutorId);
    if(!c.email)return res.status(400).json({error:'Guarda primero tu correo en Preferencias.'});
    if(c.email_verificado)return res.json({verificado:true});
    if(!process.env.GMAIL_USER||!process.env.GMAIL_APP_PASSWORD)return res.status(503).json({error:'El plantel aún no configuró el envío de correos.'});
    const ahora=Date.now();
    if(ahora-c.email_codigo_ultimo<60000)return res.status(429).json({error:'Solicita otro código después de un minuto.'});
    const codigo=String(crypto.randomInt(100000,1000000));
    const codigoHash=hash(`${req.cuentaTutorId}:${codigo}`);
    db.prepare('UPDATE tutores_cuentas SET email_codigo_hash=?,email_codigo_hasta=?,email_codigo_intentos=0,email_codigo_ultimo=? WHERE id=?')
      .run(codigoHash,ahora+10*60000,ahora,req.cuentaTutorId);
    try{
      const { enviarCorreo } = require('./gmail');
      await enviarCorreo({to:c.email,subject:'Verificar correo de LinceTutores',
        text:`Tu código de verificación es: ${codigo}. Vence en 10 minutos. No lo compartas.`});
      res.json({enviado:true});
    }catch(e){console.error('No se pudo enviar correo de verificación:',e.message);res.status(502).json({error:'No se pudo enviar el código. Revisa la configuración de Gmail.'});}
  });
  router.post('/correo/verificar',exigirSesion,limitar,(req,res)=>{
    const codigo=String(req.body?.codigo||'');
    const c=db.prepare('SELECT email_codigo_hash,email_codigo_hasta,email_codigo_intentos FROM tutores_cuentas WHERE id=?').get(req.cuentaTutorId);
    if(!/^\d{6}$/.test(codigo)||!c.email_codigo_hash||!c.email_codigo_hasta||Date.now()>c.email_codigo_hasta||c.email_codigo_intentos>=5)
      return res.status(400).json({error:'Código inválido o vencido. Solicita otro.'});
    db.prepare('UPDATE tutores_cuentas SET email_codigo_intentos=email_codigo_intentos+1 WHERE id=?').run(req.cuentaTutorId);
    const esperado=Buffer.from(c.email_codigo_hash,'hex'),recibido=Buffer.from(hash(`${req.cuentaTutorId}:${codigo}`),'hex');
    if(!crypto.timingSafeEqual(esperado,recibido))return res.status(400).json({error:'Código incorrecto.'});
    db.prepare('UPDATE tutores_cuentas SET email_verificado=1,email_codigo_hash=NULL,email_codigo_hasta=NULL WHERE id=?').run(req.cuentaTutorId);
    res.json({verificado:true});
  });
  // Confirmación del teléfono por personal del plantel, sin confiar solo en el número escrito.
  router.post('/cuentas/:id/verificar-telefono',exigirAdmin,(req,res)=>{
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<1||req.body?.numero_y_consentimiento_verificados!==true)
      return res.status(400).json({error:'Comprueba titularidad del número y consentimiento antes de verificar.'});
    const r=db.prepare('UPDATE tutores_cuentas SET telefono_verificado=1 WHERE id=?').run(id);
    res.status(r.changes?200:404).json(r.changes?{telefono_verificado:true}:{error:'Tutor no encontrado.'});
  });
  // Pendientes no filtran si una matrícula existe. La escuela verifica parentesco antes de aprobar.
  // Basta el nombre O la matrícula. Al tutor nunca se le dice si el alumno existe ni se le muestran
  // datos del padrón: el personal de seguridad ve la coincidencia en el panel y aprueba.
  router.post('/hijos', exigirSesion, limitar, (req,res) => {
    const nombreDado=String(req.body?.nombre||'').trim();
    const matriculaDada=String(req.body?.matricula||'').trim().toUpperCase();
    const hayNombre=nombreValido(nombreDado), hayMatricula=matriculaValida(matriculaDada);
    if ((nombreDado && !hayNombre) || (matriculaDada && !hayMatricula) || (!hayNombre && !hayMatricula))
      return res.status(400).json({error:'Escribe el nombre completo de tu hijo o su matrícula (con uno basta).'});
    const nombre=hayNombre?nombreDado:'';
    const matricula=hayMatricula?matriculaDada:'SIN-'+hash(claveNombre(nombreDado)).slice(0,10).toUpperCase();
    const cuentaCantidad=db.prepare('SELECT COUNT(*) n FROM tutores_hijos WHERE tutor_id=?').get(req.cuentaTutorId).n;
    if (cuentaCantidad>=12) return res.status(400).json({error:'Límite de vinculaciones alcanzado. Contacta al plantel.'});
    try {
      const r=db.prepare(`INSERT INTO tutores_hijos(tutor_id,alumno_nombre,matricula,creada_en,actualizada_en)
        VALUES(?,?,?,?,?)`).run(req.cuentaTutorId,nombre,matricula,fechaLocal(),fechaLocal());
      res.status(202).json({id:Number(r.lastInsertRowid),estado:'pendiente',mensaje:'Hijo registrado. Ya puedes utilizar las funciones de prueba; los movimientos reales necesitan autorización.'});
    } catch(e) {
      if(e.code==='SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({error:hayMatricula?'Ya agregaste esa matrícula.':'Ya agregaste a un hijo con ese nombre.'});
      return res.status(500).json({error:'No se pudo registrar al hijo.'});
    }
  });
  router.get('/hijos', exigirSesion, (req,res) => {
    const hijos=db.prepare(`SELECT h.id,h.alumno_nombre AS nombre,h.matricula,h.estado,h.emergencia_nombre,
      h.emergencia_parentesco,h.emergencia_telefono,h.usuario_id
      FROM tutores_hijos h WHERE h.tutor_id=? ORDER BY h.id DESC`).all(req.cuentaTutorId);
    const ultimo=db.prepare(`SELECT tipo,fecha_hora FROM eventos WHERE usuario_id=?
      ORDER BY fecha_hora DESC,id DESC LIMIT 1`);
    res.json({hijos:hijos.map(h => ({...h,matricula:SIN_MATRICULA.test(h.matricula)?'':h.matricula,ultimo_movimiento:h.estado==='aprobada'&&h.usuario_id ? ultimo.get(h.usuario_id)||null : null, usuario_id:undefined}))});
  });
  router.put('/hijos/:id/emergencia', exigirSesion, (req,res) => {
    const id=Number(req.params.id), hijo=hijoPorId.get(id,req.cuentaTutorId);
    if(!hijo) return res.status(404).json({error:'Hijo no encontrado en tu cuenta.'});
    const nombre=String(req.body?.nombre||'').trim();
    const parentesco=String(req.body?.parentesco||'').trim();
    const telefono=limpiarTelefono(req.body?.telefono);
    if(!nombreValido(nombre)||!['Madre','Padre','Abuela','Abuelo','Tío','Tía','Otro'].includes(parentesco)||!telefono)
      return res.status(400).json({error:'Revisa el nombre, parentesco y teléfono del contacto de emergencia.'});
    db.prepare(`UPDATE tutores_hijos SET emergencia_nombre=?,emergencia_parentesco=?,emergencia_telefono=?,actualizada_en=? WHERE id=?`)
      .run(nombre,parentesco,telefono,fechaLocal(),id);
    res.json({guardado:true});
  });
  router.get('/hijos/:id/movimientos', exigirSesion, (req,res) => {
    const hijo=hijoPorId.get(Number(req.params.id),req.cuentaTutorId);
    if(!hijo) return res.status(404).json({error:'Hijo no encontrado en tu cuenta.'});
    if(hijo.estado!=='aprobada'||!hijo.usuario_id) return res.status(403).json({error:'Los movimientos reales requieren una vinculación autorizada.'});
    const movimientos=db.prepare('SELECT id,tipo,origen,fecha_hora FROM eventos WHERE usuario_id=? ORDER BY fecha_hora DESC,id DESC LIMIT 100').all(hijo.usuario_id);
    res.json({hijo:{id:hijo.id,nombre:hijo.alumno_nombre,matricula:SIN_MATRICULA.test(hijo.matricula)?'':hijo.matricula},movimientos});
  });
  router.get('/avisos', exigirSesion, (req,res) => {
    const avisos=db.prepare(`SELECT e.id,e.tipo,e.origen,e.fecha_hora,h.id AS hijo_id,h.alumno_nombre AS nombre
      FROM tutores_hijos h JOIN eventos e ON e.usuario_id=h.usuario_id
      WHERE h.tutor_id=? AND h.estado='aprobada'
      ORDER BY e.fecha_hora DESC,e.id DESC LIMIT 80`).all(req.cuentaTutorId);
    res.json({avisos});
  });
  // Modo DEMO: sin aprobación manual, pero no permite leer los movimientos reales.
  // Solo la sesión que creó el hijo puede crear/consultar los eventos de prueba.
  router.get('/demo/avisos', exigirSesion, (req,res) => {
    const avisos=db.prepare(`SELECT d.id,d.hijo_id,d.tipo,d.fecha_hora,h.alumno_nombre AS nombre,
      'demo' AS origen,1 AS simulado
      FROM tutores_demo_eventos d JOIN tutores_hijos h ON h.id=d.hijo_id
      WHERE d.tutor_id=? AND h.tutor_id=? AND h.estado!='aprobada'
      ORDER BY d.id DESC LIMIT 80`).all(req.cuentaTutorId,req.cuentaTutorId);
    res.json({avisos});
  });
  router.get('/demo/hijos/:id/movimientos', exigirSesion, (req,res) => {
    const id=Number(req.params.id), hijo=hijoPorId.get(id,req.cuentaTutorId);
    if(!hijo) return res.status(404).json({error:'Hijo no encontrado.'});
    const movimientos=hijo.estado==='aprobada'?[]:db.prepare(`SELECT id,tipo,fecha_hora,
      'demo' AS origen,1 AS simulado
      FROM tutores_demo_eventos WHERE tutor_id=? AND hijo_id=?
      ORDER BY id DESC LIMIT 100`).all(req.cuentaTutorId,id);
    res.json({movimientos});
  });
  router.post('/demo/hijos/:id/movimientos', exigirSesion, limitar, (req,res) => {
    const id=Number(req.params.id), tipo=req.body?.tipo;
    const hijo=Number.isSafeInteger(id)&&id>0?hijoPorId.get(id,req.cuentaTutorId):null;
    if(!hijo) return res.status(404).json({error:'Hijo no encontrado en tu cuenta.'});
    if(hijo.estado==='aprobada') return res.status(409).json({error:'Este hijo ya tiene un vínculo real; no uses datos simulados.'});
    if(tipo!=='ingreso'&&tipo!=='egreso') return res.status(400).json({error:'Movimiento de demostración inválido.'});
    const fecha=fechaLocal();
    const r=db.prepare(`INSERT INTO tutores_demo_eventos(tutor_id,hijo_id,tipo,fecha_hora)
      VALUES(?,?,?,?)`).run(req.cuentaTutorId,id,tipo,fecha);
    try {req.app.locals.avisosTutores?.prepararDemo(Number(r.lastInsertRowid),req.cuentaTutorId,id);}
    catch(err){console.error('No se pudo preparar correo demo:',err.message);}
    res.status(201).json({evento:{id:Number(r.lastInsertRowid),tipo,fecha_hora:fecha,simulado:true}});
  });
  router.get('/config-push', (_req,res)=>res.json({disponible:!!(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY),clave_publica:process.env.VAPID_PUBLIC_KEY||null}));
  router.post('/suscripciones', exigirSesion, (req,res) => {
    const pref=leerPref.get(req.cuentaTutorId);
    if (!pref?.avisos_permitidos || !pref?.avisos_push) return res.status(403).json({error:'Activa avisos y celular en Mi cuenta.'});
    const s=req.body||{};
    let url;
    try {url=new URL(s.endpoint);}catch{return res.status(400).json({error:'Suscripción inválida.'});}
    const domain=url.hostname.toLowerCase();
    const permitido=url.protocol==='https:' && (domain==='fcm.googleapis.com'||domain.endsWith('.push.services.mozilla.com')||domain.endsWith('.push.apple.com')||domain.endsWith('.notify.windows.com')||domain.endsWith('.googleapis.com'));
    if(!permitido||url.href.length>1600||typeof s.keys?.p256dh!=='string'||typeof s.keys?.auth!=='string'||s.keys.p256dh.length>200||s.keys.auth.length>100)
      return res.status(400).json({error:'Suscripción inválida.'});
    db.prepare(`INSERT INTO tutores_push(tutor_id,endpoint,p256dh,auth,creada_en) VALUES(?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET tutor_id=excluded.tutor_id,p256dh=excluded.p256dh,auth=excluded.auth,creada_en=excluded.creada_en`)
      .run(req.cuentaTutorId,url.href,s.keys.p256dh,s.keys.auth,fechaLocal());
    res.json({guardado:true});
  });
  router.delete('/suscripciones',exigirSesion,(req,res)=>{
    db.prepare('DELETE FROM tutores_push WHERE tutor_id=? AND endpoint=?').run(req.cuentaTutorId,String(req.body?.endpoint||''));
    res.json({eliminado:true});
  });
  // Busca en el padrón al alumno de una solicitud: por matrícula si la dio; si no, por nombre.
  // ok = un solo alumno; si dio los dos datos, deben ser de la misma persona.
  const porMatricula=db.prepare(`SELECT u.id,u.nombre,u.matricula,u.codigo_credencial,u.tipo,c.nombre AS carrera,u.grupo
    FROM usuarios u LEFT JOIN carreras c ON c.id=u.carrera_id WHERE UPPER(u.matricula)=?`);
  const alumnos=db.prepare(`SELECT u.id,u.nombre,u.matricula,u.codigo_credencial,u.tipo,c.nombre AS carrera,u.grupo
    FROM usuarios u LEFT JOIN carreras c ON c.id=u.carrera_id WHERE u.tipo='alumno'`);
  function resolverAlumno(h){
    const conMatricula=!SIN_MATRICULA.test(h.matricula);
    if(conMatricula){
      const u=porMatricula.get(h.matricula);
      if(!u||u.tipo!=='alumno') return {estado:'no_encontrado',motivo:'Esa matrícula no está en el padrón de alumnos.'};
      if(h.alumno_nombre&&claveNombre(h.alumno_nombre)!==claveNombre(u.nombre))
        return {estado:'conflicto',usuario:u,motivo:`La matrícula es de "${u.nombre}", no de "${h.alumno_nombre}".`};
      return {estado:'ok',usuario:u};
    }
    const clave=claveNombre(h.alumno_nombre);
    const iguales=alumnos.all().filter(u=>claveNombre(u.nombre)===clave);
    if(!iguales.length) return {estado:'no_encontrado',motivo:'No hay ningún alumno con ese nombre en el padrón.'};
    if(iguales.length>1) return {estado:'varios',motivo:`Hay ${iguales.length} alumnos con ese nombre: pide al tutor la matrícula.`};
    return {estado:'ok',usuario:iguales[0]};
  }
  // Administración (sesión del panel): aprobar solo después de comprobar identidad y parentesco.
  router.get('/pendientes', exigirAdmin, (_req,res)=>res.json(db.prepare(`SELECT h.id,h.alumno_nombre,h.matricula,
    t.nombre AS tutor,t.telefono,h.creada_en FROM tutores_hijos h JOIN tutores_cuentas t ON t.id=h.tutor_id
    WHERE h.estado='pendiente' ORDER BY h.creada_en LIMIT 200`).all().map(h=>{
      const r=resolverAlumno(h);
      const u=r.usuario;
      return {...h,matricula:SIN_MATRICULA.test(h.matricula)?'':h.matricula,
        coincidencia:{estado:r.estado,motivo:r.motivo||null,
          alumno:u?{nombre:u.nombre,matricula:u.matricula,gafete:u.codigo_credencial,carrera:u.carrera,grupo:u.grupo}:null}};
    })));
  const aprobar=db.transaction((hijoId,verificado)=>{
    const h=db.prepare('SELECT * FROM tutores_hijos WHERE id=?').get(hijoId);
    if(!h||h.estado!=='pendiente') return {status:404,error:'Solicitud no encontrada o ya revisada.'};
    if(verificado!==true) return {status:400,error:'Verifica identidad y parentesco con el plantel antes de aprobar.'};
    const r=resolverAlumno(h);
    if(r.estado!=='ok') return {status:409,error:r.motivo||'No se encontró al alumno en el padrón.'};
    const usuario=r.usuario;
    // Se guardan los datos del padrón: desde aquí manda la base de datos
    db.prepare(`UPDATE tutores_hijos SET estado='aprobada',usuario_id=?,alumno_nombre=?,matricula=?,actualizada_en=? WHERE id=?`)
      .run(usuario.id,usuario.nombre,String(usuario.matricula).toUpperCase(),fechaLocal(),hijoId);
    return {estado:'aprobada',hijo_id:hijoId};
  });
  router.post('/hijos/:id/aprobar',exigirAdmin,(req,res)=>{
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<=0) return res.status(400).json({error:'ID inválido.'});
    const r=aprobar.immediate(id,req.body?.identidad_y_parentesco_verificados);
    res.status(r.status||200).json(r.error?{error:r.error}:r);
  });
  router.post('/hijos/:id/rechazar',exigirAdmin,(req,res)=>{
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<=0) return res.status(400).json({error:'ID inválido.'});
    const r=db.prepare(`UPDATE tutores_hijos SET estado='rechazada',actualizada_en=? WHERE id=? AND estado='pendiente'`).run(fechaLocal(),id);
    res.status(r.changes?200:404).json(r.changes?{estado:'rechazada'}:{error:'Solicitud no disponible.'});
  });
  return router;
}
module.exports=crearRutasTutores;
module.exports.crearEsquemaTutores=crearEsquemaTutores;
