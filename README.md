# Control de accesos — Hackatón LinceCode 2026

Un solo servidor Express + SQLite sirve todo:

| Parte | Carpeta | URL |
|---|---|---|
| Servidor y base de datos (Persona 1) | `server/` | `http://localhost:3000/api/...` |
| Kiosco de credenciales (Persona 2) | `kiosco/` | `http://localhost:3000/kiosco/` |
| Dashboard del guardia + IA (Persona 3) | `dashboard/`, `server/ia.js` | `http://localhost:3000/` → `/dashboard/` |
| Documentación (Persona 4) | `docs/` | — |

El contrato de la API está en [docs/CONTRATO_API.md](docs/CONTRATO_API.md) y el diseño de la base en [docs/ESQUEMA.md](docs/ESQUEMA.md).

## Requisitos
- **Node.js 22 o más reciente** (https://nodejs.org, versión LTS). Comprueba con `node -v`.
- No hace falta MySQL: la base es el archivo `server/lincecode.db` (SQLite), se crea solo.

## Arrancar (Windows, PowerShell)

```powershell
cd server
npm.cmd install
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Pega la clave generada en `QR_SECRET=` del archivo `server/.env`; genera **otra** y pégala en `ADMIN_KEY=`.
Opcional: `IA_API_KEY=` para el chat con IA (sin ella el chat responde con datos calculados, "modo sin IA").

```powershell
node seed.js      # 50 usuarios de prueba, una semana de eventos y 3 permisos nocturnos
npm.cmd test      # pruebas automáticas (usan una base temporal)
node server.js    # deja esta terminal abierta
```

Abre:
- Dashboard: http://localhost:3000
- Kiosco: http://localhost:3000/kiosco/?kiosco=K-PUERTA1&modo=mixto (`modo` = `entrada`, `salida` o `mixto`)

Credenciales de prueba: `LINCE-01` … `LINCE-50` (las 11, 22, 33 y 44 están inactivas; 13, 26 y 39 son externos). NIP de prueba `1234`.

## Clave de administrador en el dashboard
Agregar o editar usuarios, reponer credenciales, crear permisos y ejecutar el cierre requieren la `ADMIN_KEY`.
El dashboard la pide la primera vez y la recuerda mientras la pestaña esté abierta.

## Probar sin servidor
Abre `dashboard/index.html?mock=1`: usa datos simulados (`dashboard/js/mock.js`) y muestra el aviso "MODO DEMO".

## Seguridad
- Solo en la laptop y en Wi-Fi de confianza; no abrir el puerto 3000 a internet.
- `server/.env` y `*.db` no se suben a Git.
- La cámara del kiosco en un celular necesita HTTPS (ver `HTTPS_KEY_PATH`/`HTTPS_CERT_PATH` en `.env.example`); con lector USB en la laptop no hace falta.
