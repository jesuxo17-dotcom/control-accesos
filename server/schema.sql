-- Hackatón LinceCode 2026: seis tablas acordadas por el equipo.
-- fecha_hora y expira: 'YYYY-MM-DD HH:MM:SS' en America/Mazatlan.
CREATE TABLE IF NOT EXISTS carreras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  matricula TEXT NOT NULL UNIQUE,
  codigo_credencial TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('alumno','docente','administrativo')),
  carrera_id INTEGER REFERENCES carreras(id),
  grupo TEXT,
  estatus TEXT NOT NULL CHECK (estatus IN ('activo','inactivo','externo')),
  foto_url TEXT,
  nip TEXT NOT NULL,
  tutor_email TEXT,
  tutor_telefono TEXT,
  notificar_tutor INTEGER NOT NULL DEFAULT 0 CHECK (notificar_tutor IN (0,1)),
  -- Opcionales (asistente de IA): vacíos si no se capturaron. Las bases
  -- creadas antes de estas columnas las reciben con ALTER TABLE en db.js.
  semestre INTEGER CHECK (semestre BETWEEN 1 AND 12),
  equipo TEXT,
  -- Correo del propio usuario: ahí le llega el aviso de cada entrada y salida en el kiosco
  email TEXT
);

CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','egreso')),
  origen TEXT NOT NULL CHECK (origen IN ('kiosco','automatico')),
  kiosco_id TEXT,
  foto_captura TEXT,
  fecha_hora TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_leido TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  motivo TEXT NOT NULL,
  kiosco_id TEXT,
  fecha_hora TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notificaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evento_id INTEGER NOT NULL REFERENCES eventos(id),
  canal TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','enviado','error')),
  fecha_hora TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens_qr (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  expira TEXT NOT NULL,
  usado INTEGER NOT NULL DEFAULT 0 CHECK (usado IN (0,1))
);

-- Permisos nocturnos (eventos donde la gente se queda después de las 00:00).
-- Una fila por persona. Quien tiene un permiso vigente NO recibe la salida
-- automática del cierre y sigue contando como "dentro" al cambiar de día.
-- La usan server/permisos.js, db.js (aforo), scan.js, cierre.js e ia.js.
CREATE TABLE IF NOT EXISTS permisos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  nombre TEXT NOT NULL,
  desde TEXT NOT NULL,
  hasta TEXT NOT NULL,
  autorizado_por TEXT,
  creado TEXT NOT NULL,
  CHECK (hasta > desde)
);

-- Historial inmutable. No se permite UPDATE ni DELETE, incluso para administradores.
CREATE TRIGGER IF NOT EXISTS trg_eventos_no_update
BEFORE UPDATE ON eventos
BEGIN
  SELECT RAISE(ABORT, 'eventos es de solo INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg_eventos_no_delete
BEFORE DELETE ON eventos
BEGIN
  SELECT RAISE(ABORT, 'eventos es de solo INSERT');
END;

CREATE INDEX IF NOT EXISTS idx_eventos_usuario_fecha ON eventos(usuario_id, fecha_hora, id);
CREATE INDEX IF NOT EXISTS idx_eventos_fecha ON eventos(fecha_hora);
CREATE INDEX IF NOT EXISTS idx_intentos_fecha ON intentos(fecha_hora);
CREATE INDEX IF NOT EXISTS idx_tokens_qr_usuario ON tokens_qr(usuario_id);
CREATE INDEX IF NOT EXISTS idx_permisos_usuario ON permisos(usuario_id, desde, hasta);
