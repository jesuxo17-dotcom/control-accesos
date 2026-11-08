# Diseño de la base de datos SQLite — Persona 1

## Tablas
| Tabla | Datos principales | Función |
|---|---|---|
| carreras | id, nombre | Catálogo de carreras |
| usuarios | matrícula, credencial, tipo, carrera_id, grupo, estatus, foto_url, nip, tutor | Catálogo de alumnos, docentes y administrativos |
| eventos | usuario_id, ingreso/egreso, origen, kiosco_id, fecha_hora | Historial inmutable (solo INSERT) |
| intentos | código leído, usuario_id, motivo, fecha_hora | Escaneos rechazados y repetidos |
| notificaciones | evento_id, canal, estado, fecha_hora | Cola de correo al tutor |
| tokens_qr | token, usuario_id, expira, usado | Impide reutilizar QR dinámicos |

## Relaciones
- carreras **1 a muchos** usuarios.
- usuarios **1 a muchos** eventos.
- usuarios **1 a muchos** intentos.
- usuarios **1 a muchos** tokens_qr.
- eventos **1 a muchos** notificaciones.

## Integridad
Dos triggers (`trg_eventos_no_update` y `trg_eventos_no_delete`) abortan todo UPDATE o DELETE en `eventos`. Las salidas automáticas se registran con un INSERT nuevo y `origen='automatico'`.

## Aforo
Una consulta con `ROW_NUMBER()` obtiene el último evento de cada usuario durante la fecha local `America/Mazatlan`. Si ese evento es `ingreso`, cuenta como persona dentro. En reportes se agrupan por carrera y por grupo.

## PDF
Esta explicación puede incorporarse al documento que entregará Persona 4, acompañada por capturas de la demo y los resultados de los tests.
