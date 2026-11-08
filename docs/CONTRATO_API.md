# Contrato para las Personas 2, 3 y 4

**Base** `http://IP-DE-LA-LAPTOP:3000` en red local, o `https://IP:3000` con mkcert.
Formato `fecha_hora`: `YYYY-MM-DD HH:MM:SS` **America/Mazatlan**. No es UTC.

## Rutas exactas
- `POST /api/scan` entrada `{codigo,kiosco_id,modo:"entrada"|"salida"|"mixto",foto_base64?}`. Respuesta `{resultado,color,motivo,usuario,fecha_hora}`.
- `GET /api/aforo` → `{total,por_carrera:[{carrera,dentro}],por_grupo:[{grupo,dentro}]}`.
- `GET /api/eventos?desde=&hasta=&carrera=&usuario_id=` → arreglo de `{id,nombre,carrera,tipo,origen,kiosco_id,fecha_hora}`. **carrera es nombre**, no ID.
- `GET /api/usuarios` → arreglo de objetos con `carrera_id` **y** `carrera` (nombre), sin campo privado `nip`.
- `POST /api/usuarios` y `PUT /api/usuarios/:id` → requieren cabecera `x-admin-key` igual a `ADMIN_KEY` en `.env`.
- `POST /api/mi-qr` `{matricula,nip}` → `{qr,expira_en:30}`. QR `D.<id>.<timestamp_milisegundos>.<HMAC-SHA256>`.
- `POST /api/cierre` → `{cerrados}`; requiere `x-admin-key`.
- `GET /api/anomalias` → `[{tipo,mensaje,usuario,fecha_hora}]`; si existe `server/ia.js`, sus rutas toman prioridad.
- `POST /api/chat` `{pregunta}` → `{respuesta}`. Antes de integrar `ia.js` responde **501** indicando que falta Persona 3.

### Respuesta /api/scan (formato fijo)
```json
{
  "resultado": "ingreso",
  "color": "verde",
  "motivo": null,
  "usuario": {
    "id": 1,
    "nombre": "PERSONA DE PRUEBA 01",
    "foto_url": "/fotos/usuario-01.svg",
    "carrera": "Tecnologías de la Información",
    "grupo": "G32",
    "tipo": "alumno"
  },
  "fecha_hora": "2026-11-07 16:30:00"
}
```

Motivos de respuesta: `null`, `no_registrada`, `inactiva`, `externo`, `repetido`, `ya_dentro`, `codigo_vencido`.
**Pendiente de acuerdo de equipo:** el modo salida sin ingreso previo no dispone de motivo en ese conjunto. Por eso la API devuelve `resultado:"rechazado", motivo:null`; en la tabla `intentos` y el evento `alerta` queda `sin_ingreso` para que el equipo lo identifique sin cambiar el contrato.

## Socket.IO
- `evento`: misma respuesta de `/api/scan` **más** `kiosco_id`, solo para ingresos/egresos aceptados.
- `alerta`: `{tipo,mensaje,usuario,fecha_hora}` en rechazos.
- `aforo`: mismo objeto que `GET /api/aforo`, luego de cada escaneo (aceptado o rechazado), en conexión inicial y tras cierre con cambios.

## Identificación y códigos
- QR impreso: solo `codigo_credencial`, por ejemplo `LINCE-01`.
- QR dinámico: requiere matrícula y NIP; 30 segundos, firma HMAC, no reutilizable.
- Kiosco `entrada`: rechaza `ya_dentro` cuando el último evento local del día es ingreso.
- Kiosco `salida`: rechaza si no ha ingresado.
- Kiosco `mixto`: alterna automáticamente.
- Usuario inactivo: rojo y rechazo; externo: registro exitoso, ámbar y motivo `externo` (sujeto a la confirmación indicada en el enunciado).
- Escaneos exitosos con menos de 60 s: respuesta `repetido` y entrada en `intentos`, sin cambiar el aforo.

## Tiempo y cierre
- Cron `0 0 * * *`, zona `America/Mazatlan`, cierra **día anterior** con un egreso automático a las 23:59:59 del día terminado.
- Cierre manual cierra **día actual** con fecha/hora presente; por transacción es idempotente.
- `eventos` es de solo INSERT mediante triggers. No hay borrado ni edición de registros.

## Integración con Persona 3
Copia su archivo en `server/ia.js`, exportando una función `module.exports = (db, io) => router;`. El servidor lo monta automáticamente después de `express.json()` mediante `app.use(require('./ia')(db, io));`. Deja `IA_API_KEY` en `.env` sin publicarla. Las funciones de servidor para IA se exportan desde `server/consultas.js`: `aforo_por_carrera(carrera)`, `usuarios_dentro()` y `entradas_en_rango(desde,hasta)` a través de `require('./consultas')(db)`.

## Seguridad de demo
No abrir el puerto 3000 a internet. Usar datos ficticios. El SDK de Anthropic se instala para Persona 3, pero el servidor de Persona 1 no envía datos a ningún proveedor de IA por sí solo.

## Ampliaciones al integrar dashboard y kiosco (Persona 3)
Todo lo anterior sigue igual; estos campos y rutas son **adicionales** (quien no los use los puede ignorar).

### Permisos nocturnos
Tabla `permisos (id, usuario_id, nombre, desde, hasta, autorizado_por, creado)`. Quien tiene un permiso vigente:
- sigue contando como **dentro** aunque haya entrado el día anterior;
- **no** recibe la salida automática del cierre (cron 00:00 ni cierre manual).

Rutas:
- `GET /api/permisos` → `[{id,usuario_id,usuario,nombre,desde,hasta,autorizado_por,creado}]`.
- `POST /api/permisos` (requiere `x-admin-key`) `{nombre,desde,hasta}` + **uno** de `usuario_ids:[...]`, `carrera_id` o `grupo` → `201 {creados}`. Crea una fila por persona (excepto inactivos).
- `GET /api/dentro-sin-permiso` → `[{id,nombre,foto_url,carrera,grupo,tipo,desde}]`: quién está dentro ahora sin permiso (revisión de las 23:30).

Campos nuevos:
- `GET /api/aforo` y el evento `aforo` traen `con_permiso` (número).
- `POST /api/scan` y el evento `evento` traen `permiso: null | {nombre, hasta}`.
- Alerta `noche_sin_permiso`: un kiosco de salida lee a alguien a quien el cierre ya le marcó salida automática.

### Usuarios
- `POST /api/usuarios`: `nip` ahora es **opcional** (el dashboard no lo captura). Sin NIP, la persona usa su credencial impresa y no puede pedir QR dinámico hasta que se le asigne uno con `PUT {nip}`.
- `POST /api/usuarios/:id/reponer` (requiere `x-admin-key`) → `{codigo_credencial}`: código nuevo `XXXX-XXXX-XXXX`; el anterior deja de funcionar (`no_registrada`).

### Dashboard
- `GET /dashboard/vendor/chart.umd.min.js` se sirve desde `node_modules/chart.js` (funciona sin internet).
- El dashboard pide la `ADMIN_KEY` la primera vez que se guarda algo y la recuerda solo mientras la pestaña está abierta.
