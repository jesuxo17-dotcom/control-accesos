/* =====================================================================
   usuarios.js — Lógica de usuarios.html
   - Carga GET /api/usuarios y lo muestra en tabla con filtros.
   - "Agregar" -> POST /api/usuarios ; "Editar" -> PUT /api/usuarios/:id
   - "Reponer" -> POST /api/usuarios/:id/reponer (código nuevo de 12 caracteres)
   - La foto se puede tomar con la cámara del celular o elegir un
     archivo; se reduce a 240 px y se guarda como data URL en foto_url
     (suficiente para la demo, sin servidor de archivos).
   ===================================================================== */

const $ = id => document.getElementById(id);
let usuarios = [];
let editandoId = null;          // null = alta nueva
let carreras = new Map();       // carrera_id -> nombre

// Como la API no tiene /api/carreras, deducimos el catálogo de los usuarios.
function deducirCarreras() {
  carreras = new Map();
  for (const u of usuarios) if (u.carrera_id) carreras.set(Number(u.carrera_id), u.carrera || `Carrera ${u.carrera_id}`);
  if (!carreras.size) for (let i = 1; i <= 5; i++) carreras.set(i, `Carrera ${i}`);
  $('carrera_id').innerHTML = '<option value="">— Sin carrera —</option>' +
    [...carreras].sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('');
}

async function cargar() {
  try {
    usuarios = await API.usuarios();
    deducirCarreras();
    pintar();
  } catch (e) {
    toast('Error cargando usuarios: ' + e.message, 'error');
  }
}

function pintar() {
  const txt = $('f-buscar').value.trim().toLowerCase();
  const tipo = $('f-tipo').value;
  const est = $('f-estatus').value;
  const lista = usuarios.filter(u =>
    (!tipo || u.tipo === tipo) && (!est || u.estatus === est) &&
    (!txt || [u.nombre, u.matricula, u.codigo_credencial].some(v => String(v || '').toLowerCase().includes(txt))));

  const cuenta = s => usuarios.filter(u => u.estatus === s).length;
  $('resumen').textContent = `${lista.length} de ${usuarios.length} usuarios · ` +
    `${cuenta('activo')} activos · ${cuenta('inactivo')} inactivos · ${cuenta('externo')} externos`;

  $('tabla').innerHTML = lista.length ? lista.map(u => `
    <tr>
      <td>${imgUsuario(u)}</td>
      <td><b>${esc(u.nombre)}</b></td>
      <td>${esc(u.matricula)}</td>
      <td><code>${esc(u.codigo_credencial)}</code></td>
      <td>${esc(u.tipo)}</td>
      <td>${esc(u.carrera || carreras.get(Number(u.carrera_id)) || '')}</td>
      <td>${esc(u.grupo || '')}</td>
      <td>${u.semestre ? esc(u.semestre) + '.º' : ''}</td>
      <td><span class="badge ${esc(u.estatus)}">${esc(u.estatus)}</span></td>
      <td><button data-id="${u.id}">Editar</button></td>
    </tr>`).join('') : '<tr><td colspan="10" class="vacio">Sin resultados</td></tr>';
}

// ---------- Formulario ----------
// Ya no hay QR dinámico, así que el NIP no se captura aquí.
const CAMPOS = ['nombre', 'matricula', 'codigo_credencial', 'tipo', 'carrera_id', 'grupo', 'semestre', 'email', 'estatus',
  'foto_url', 'tutor_email', 'tutor_telefono'];

function abrir(u) {
  editandoId = u ? u.id : null;
  $('dlg-titulo').textContent = u ? 'Editar usuario' : 'Nuevo usuario';
  for (const c of CAMPOS) $(c).value = u ? (u[c] ?? '') : '';
  if (!u) {
    $('tipo').value = 'alumno'; $('estatus').value = 'activo';
    $('codigo_credencial').value = codigoAleatorio();   // código aleatorio, NUNCA la matrícula
    // PRUEBAS: carrera al azar ya seleccionada (se puede cambiar antes de guardar)
    const ids = [...carreras.keys()];
    if (ids.length) $('carrera_id').value = String(ids[Math.floor(Math.random() * ids.length)]);
  }
  // Al editar, el código no se teclea: solo se cambia con "Reponer" (POST /api/usuarios/:id/reponer)
  $('codigo_credencial').readOnly = !!u;
  $('btn-reponer').hidden = !u;
  $('notificar_tutor').checked = u ? !!Number(u.notificar_tutor) : false;
  // Los datos del tutor no se descargan (privados): al editar, vacío = conservar
  for (const c of ['tutor_email', 'tutor_telefono']) $(c).placeholder = u ? 'Se conserva el actual si lo dejas vacío' : '';
  $('foto_archivo').value = '';
  actualizarVista();
  $('dlg').showModal();
}

function actualizarVista() {
  $('vista').src = $('foto_url').value || avatar($('nombre').value || '?');
}
$('foto_url').addEventListener('input', actualizarVista);
$('nombre').addEventListener('input', actualizarVista);

// Reduce la foto a 240 px de ancho y la convierte a JPEG base64
$('foto_archivo').addEventListener('change', e => {
  const archivo = e.target.files[0];
  if (!archivo) return;
  const img = new Image();
  img.onload = () => {
    const lado = 240, esc2 = lado / Math.max(img.width, img.height);
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * esc2); cv.height = Math.round(img.height * esc2);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    $('foto_url').value = cv.toDataURL('image/jpeg', 0.8);
    actualizarVista();
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(archivo);
});

$('form').addEventListener('submit', async e => {
  e.preventDefault();
  const datos = {};
  for (const c of CAMPOS) datos[c] = $(c).value.trim() || null;
  datos.carrera_id = datos.carrera_id ? Number(datos.carrera_id) : null;
  datos.semestre = datos.semestre ? Number(datos.semestre) : null;
  datos.notificar_tutor = $('notificar_tutor').checked ? 1 : 0;
  if (editandoId) delete datos.codigo_credencial;   // el código solo cambia con "Reponer"

  // Validación rápida: credencial y matrícula únicas
  const choca = usuarios.find(u => u.id !== editandoId &&
    ((datos.codigo_credencial && u.codigo_credencial === datos.codigo_credencial) || u.matricula === datos.matricula));
  if (choca) return toast(`La matrícula o credencial ya la tiene ${choca.nombre}`, 'error');

  // Al editar se mandan SOLO los campos que cambiaron. GET /api/usuarios no
  // devuelve los datos del tutor (son privados), así que si esos campos
  // quedan vacíos se conservan los que ya tiene guardados el servidor.
  if (editandoId) {
    const original = usuarios.find(u => u.id === editandoId) || {};
    for (const c of Object.keys(datos)) {
      const antes = original[c] ?? null;
      let igual;
      if (c === 'carrera_id') igual = (antes == null ? null : Number(antes)) === datos[c];
      else if (c === 'notificar_tutor') igual = Number(antes || 0) === datos[c];
      else igual = String(antes ?? '') === String(datos[c] ?? '');
      if (igual || ((c === 'tutor_email' || c === 'tutor_telefono') && datos[c] == null)) delete datos[c];
    }
    if (!Object.keys(datos).length) { $('dlg').close(); return toast('Sin cambios', 'info'); }
  }

  $('btn-guardar').disabled = true;
  try {
    if (editandoId) await API.editarUsuario(editandoId, datos);
    else await API.crearUsuario(datos);
    $('dlg').close();
    toast(editandoId ? 'Usuario actualizado' : 'Usuario agregado', 'ok');
    await cargar();
  } catch (err) {
    toast('No se pudo guardar: ' + err.message, 'error');
  } finally {
    $('btn-guardar').disabled = false;
  }
});

// ---------- Reponer credencial (pérdida o robo) ----------
// POST /api/usuarios/:id/reponer -> {codigo_credencial}; el código anterior
// queda inválido y el kiosco lo rechazará como "no_registrada".
$('btn-reponer').addEventListener('click', async () => {
  if (!editandoId) return;
  if (!confirm('Se generará un código NUEVO y la credencial actual dejará de funcionar. ' +
               'Habrá que imprimir un QR nuevo. ¿Continuar?')) return;
  $('btn-reponer').disabled = true;
  try {
    const r = await API.reponer(editandoId);
    $('codigo_credencial').value = r.codigo_credencial;
    const u = usuarios.find(x => x.id === editandoId);
    if (u) u.codigo_credencial = r.codigo_credencial;
    pintar();
    toast('Credencial repuesta. Nuevo código: ' + r.codigo_credencial, 'ok');
  } catch (err) {
    toast('No se pudo reponer: ' + err.message, 'error');
  } finally {
    $('btn-reponer').disabled = false;
  }
});

// ---------- Eventos de la página ----------
$('btn-cancelar').onclick = () => $('dlg').close();
$('btn-nuevo').onclick = () => abrir(null);
$('tabla').addEventListener('click', e => {
  const id = e.target.dataset.id;
  if (id) abrir(usuarios.find(u => String(u.id) === id));
});
['f-buscar', 'f-tipo', 'f-estatus'].forEach(id => $(id).addEventListener('input', pintar));

cargar();
