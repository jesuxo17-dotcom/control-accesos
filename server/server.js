// Servidor principal. Ejecutar desde server/: node server.js
process.env.TZ = 'America/Mazatlan';
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { db, obtenerAforo, usuariosDentro, fechaLocal } = require('./db');
const crearPermisos = require('./permisos');
const { crearQR } = require('./qr');
const { exigirAdmin, claveAdminValida, sesionValida, login, logout } = require('./seguridad');
const crearRutaScan = require('./scan');
const crearUsuarios = require('./usuarios');
const crearNotificaciones = require('./notificaciones');
const configurarCierre = require('./cierre');
const crearConsultas = require('./consultas');

const app = express();
const PORT = Number(process.env.PORT || 3000);
let servidor;
// HTTPS opcional: guardar certificados mkcert fuera de GitHub.
if (process.env.HTTPS_KEY_PATH && process.env.HTTPS_CERT_PATH) {
  servidor = https.createServer({
    key: fs.readFileSync(path.resolve(__dirname, process.env.HTTPS_KEY_PATH)),
    cert: fs.readFileSync(path.resolve(__dirname, process.env.HTTPS_CERT_PATH))
  }, app);
} else {
  servidor = http.createServer(app);
}
const io = new Server(servidor, { cors: { origin: '*' } });

// Middleware antes de registrar TODAS las rutas.
app.use(cors());
// 6 MB: /api/scan-foto recibe una foto JPEG en base64
app.use(express.json({ limit: '6mb' }));
// Detrás del túnel de Cloudflare la IP real llega en X-Forwarded-For (para limitar intentos de login)
app.set('trust proxy', 'loopback');

// ---------- Acceso al panel ----------
// Toda la API pide sesión (o x-admin-key) salvo lo que usa el kiosco y el propio login.
// ---------- LinceTutores (app de padres y tutores) ----------
// Su API tiene su propia sesión (cookie del tutor); las rutas del plantel (aprobar vínculos)
// usan exigirAdmin, que acepta la sesión del panel. Se monta antes del candado del panel.
const crearRutasTutores = require('./tutores');
const crearGestorAvisos = require('./tutor_avisos');
const crearEnvioPush = require('./tutor_push');
app.use('/tutores', express.static(path.join(__dirname, '..', 'tutores')));
app.use('/api/tutores', crearRutasTutores(db));
const avisosTutores = crearGestorAvisos(db);
app.locals.avisosTutores = avisosTutores;
const tutores = { avisos: avisosTutores, push: crearEnvioPush(db) };

app.post('/api/login', login);
app.post('/api/logout', logout);
const RUTAS_PUBLICAS = new Set(['POST /api/scan', 'POST /api/scan-foto', 'POST /api/mi-qr', 'GET /api/estado']);
app.use('/api', (req, res, next) => {
  if (RUTAS_PUBLICAS.has(`${req.method} /api${req.path}`) || claveAdminValida(req)) return next();
  res.status(401).json({ error: 'Inicia sesión en el panel para ver esta información' });
});
app.use('/fotos', express.static(path.join(__dirname, 'public', 'fotos')));
// Lector de códigos del kiosco (zxing-wasm), servido desde node_modules: funciona sin internet.
const ARCHIVOS_ZXING = {
  'zxing-reader.js': 'dist/iife/reader/index.js',
  'zxing_reader.wasm': 'dist/reader/zxing_reader.wasm'
};
app.get('/kiosco/vendor/:archivo', (req, res, next) => {
  const ruta = ARCHIVOS_ZXING[req.params.archivo];
  if (!ruta) return next();
  res.sendFile(path.join(__dirname, 'node_modules', 'zxing-wasm', ruta), err => err && next());
});
app.use('/kiosco', express.static(path.join(__dirname, '..', 'kiosco')));
// Chart.js para el dashboard SIN internet: se sirve desde node_modules
// (dependencia "chart.js" en package.json) en la ruta que espera dashboard/index.html.
app.get('/dashboard/vendor/chart.umd.min.js', (_req, res, next) => {
  // chart.js no exporta esa subruta, así que se ubica desde su archivo principal (dist/chart.cjs)
  try { res.sendFile(path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.min.js')); }
  catch { next(); }
});
app.use('/dashboard', express.static(path.join(__dirname, '..', 'dashboard')));

// Persona 3: al copiar server/ia.js esta línea lo conectará sin cambiar la API.
// Se monta después de express.json() y recibe exactamente (db, io).
const archivoIA = path.join(__dirname, 'ia.js');
if (fs.existsSync(archivoIA)) {
  app.use(require('./ia')(db, io));
  console.log('Módulo de IA de Persona 3 conectado');
}

const procesarNotificaciones = crearNotificaciones(db);
const { cerrarDia } = configurarCierre(db, io, obtenerAforo);
const consultas = crearConsultas(db);
app.locals.db = db;
app.locals.io = io;
app.locals.consultasIA = consultas;

// La página principal abre el dashboard visual; las rutas /api/ siguen intactas.
app.get('/', (_req, res) => res.redirect('/dashboard/'));
// Conservamos la consulta JSON de estado en una ruta independiente.
app.get('/api/estado', (_req, res) => res.json({ mensaje: 'LinceCode 2026 funcionando', servidor: 'Express', base_datos: 'SQLite', fecha_hora: fechaLocal() }));
app.get('/api/aforo', (_req, res) => res.json(obtenerAforo()));
// Lectura del gafete por foto (respaldo del código de barras). Solo si hay IA_API_KEY.
let leerGafete = null;
if (process.env.IA_API_KEY) {
  const sdk = require('@anthropic-ai/sdk');
  const Anthropic = sdk.Anthropic || sdk.default || sdk;
  const clienteVision = new Anthropic({ apiKey: process.env.IA_API_KEY, timeout: 30000, maxRetries: 1 });
  const { leerGafeteConVision } = require('./gafete');
  leerGafete = (foto, tipo) => leerGafeteConVision(clienteVision, foto, tipo);
  console.log('Lectura de gafetes por foto: activa');
} else {
  console.log('Lectura de gafetes por foto: desactivada (falta IA_API_KEY); solo código de barras');
}
app.use('/api', crearRutaScan(db, io, procesarNotificaciones, leerGafete, tutores));

app.post('/api/mi-qr', (req, res) => {
  const { matricula, nip } = req.body || {};
  if (typeof matricula !== 'string' || typeof nip !== 'string') {
    return res.status(400).json({ error: 'Se requieren matricula y nip' });
  }
  try {
    const respuesta = crearQR(db, matricula, nip);
    if (!respuesta) return res.status(401).json({ error: 'Credenciales incorrectas o usuario inactivo' });
    res.json(respuesta);
  } catch (error) {
    console.error(error.message);
    res.status(503).json({ error: 'Configura QR_SECRET en .env' });
  }
});

app.get('/api/eventos', (req, res) => {
  const { desde, hasta, carrera, usuario_id } = req.query;
  let sql = `SELECT e.id, u.nombre, c.nombre AS carrera, e.tipo, e.origen, e.kiosco_id, e.fecha_hora
    FROM eventos e JOIN usuarios u ON u.id = e.usuario_id
    LEFT JOIN carreras c ON c.id = u.carrera_id WHERE 1 = 1`;
  const params = [];
  if (desde) { sql += ' AND e.fecha_hora >= ?'; params.push(String(desde)); }
  if (hasta) { sql += ' AND e.fecha_hora <= ?'; params.push(/^\d{4}-\d\d-\d\d$/.test(String(hasta)) ? hasta + ' 23:59:59' : String(hasta)); }
  if (carrera) { sql += ' AND c.nombre = ?'; params.push(String(carrera)); }
  if (usuario_id) {
    if (!/^\d+$/.test(String(usuario_id))) return res.status(400).json({ error: 'usuario_id inválido' });
    sql += ' AND u.id = ?'; params.push(Number(usuario_id));
  }
  sql += ' ORDER BY e.fecha_hora DESC, e.id DESC LIMIT 1000';
  res.json(db.prepare(sql).all(...params));
});
app.use('/api/usuarios', crearUsuarios(db));
// Permisos nocturnos: /api/permisos y /api/dentro-sin-permiso
app.use('/api', crearPermisos(db, usuariosDentro));
app.post('/api/cierre', exigirAdmin, (_req, res) => {
  try { res.json(cerrarDia()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

// Respaldos para desarrollar sin ia.js. Cuando Persona 3 lo agregue, sus rutas toman prioridad.
app.get('/api/anomalias', (_req, res) => {
  const filas = db.prepare(`SELECT i.motivo AS tipo, i.fecha_hora, u.nombre AS nombre
    FROM intentos i LEFT JOIN usuarios u ON u.id = i.usuario_id
    ORDER BY i.fecha_hora DESC, i.id DESC LIMIT 100`).all();
  res.json(filas.map(r => ({ tipo: r.tipo, mensaje: `Escaneo rechazado: ${r.tipo}`, usuario: r.nombre || null, fecha_hora: r.fecha_hora })));
});
app.post('/api/chat', (_req, res) => res.status(501).json({ respuesta: 'El chat de IA quedará disponible cuando Persona 3 agregue server/ia.js.' }));

// Los datos en vivo (accesos, alertas, aforo) solo llegan al panel con sesión
io.use((socket, next) => sesionValida(socket.handshake.auth?.token) ? next() : next(new Error('no autorizado')));
io.on('connection', socket => {
  console.log('Cliente conectado:', socket.id);
  socket.emit('aforo', obtenerAforo());
});
servidor.listen(PORT, '0.0.0.0', () => {
  console.log('=== Hackatón LinceCode 2026 ===');
  console.log(`Servidor: ${servidor instanceof https.Server ? 'https' : 'http'}://localhost:${PORT}`);
  console.log('Base de datos SQLite lista | Socket.IO activo');
});
module.exports = { app, servidor, io };
