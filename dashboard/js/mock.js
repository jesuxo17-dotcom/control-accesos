/* =====================================================================
   mock.js — Servidor FALSO dentro del navegador.
   Mientras el backend (Persona 1) no esté listo, este archivo responde
   con datos que tienen EXACTAMENTE la misma forma que la API real y
   simula los eventos de Socket.IO ("evento", "alerta", "aforo").
   Cuando el servidor real responde, api.js deja de usar este archivo.
   ===================================================================== */

const Mock = (() => {
  // ---------- Catálogos falsos ----------
  const carreras = [
    { id: 1, nombre: 'Sistemas Computacionales' },
    { id: 2, nombre: 'Industrial' },
    { id: 3, nombre: 'Mecatrónica' },
    { id: 4, nombre: 'Gestión Empresarial' },
    { id: 5, nombre: 'Administración' }
  ];
  const nombres = ['Ana', 'Luis', 'María', 'Jorge', 'Sofía', 'Diego', 'Valeria', 'Carlos', 'Fernanda',
    'Miguel', 'Camila', 'José', 'Daniela', 'Ricardo', 'Paola', 'Andrés', 'Regina', 'Emilio', 'Ximena', 'Raúl'];
  const apellidos = ['López', 'García', 'Hernández', 'Martínez', 'Ramírez', 'Torres', 'Flores', 'Castro',
    'Osuna', 'Zazueta', 'Lizárraga', 'Félix', 'Rivera', 'Medina'];
  const grupos = ['1A', '3B', '5A', '7C', '9A'];
  const kioscos = ['K-PUERTA1', 'K-PUERTA2'];

  // ---------- Usuarios falsos (misma forma que la tabla usuarios) ----------
  const usuarios = [];
  for (let i = 1; i <= 45; i++) {
    const tipo = i <= 38 ? 'alumno' : (i <= 42 ? 'docente' : 'administrativo');
    const c = carreras[i % carreras.length];
    usuarios.push({
      id: i,
      matricula: String(22170000 + i),
      codigo_credencial: codigoAleatorio(),   // QR fijo: código aleatorio, NO la matrícula
      nombre: `${nombres[i % nombres.length]} ${apellidos[(i * 7) % apellidos.length]} ${apellidos[(i * 3) % apellidos.length]}`,
      tipo,
      carrera_id: c.id,
      carrera: c.nombre,
      grupo: tipo === 'alumno' ? grupos[i % grupos.length] : null,
      estatus: i % 15 === 0 ? 'inactivo' : (i % 22 === 0 ? 'externo' : 'activo'),
      foto_url: null,               // null => la interfaz dibuja avatar con iniciales
      nip: '1234',
      tutor_email: tipo === 'alumno' ? `tutor${i}@correo.com` : null,
      tutor_telefono: null,
      notificar_tutor: tipo === 'alumno' ? 1 : 0
    });
  }

  // ---------- Permisos nocturnos falsos (misma forma que la tabla permisos) ----------
  // Un permiso por persona: hoy 06:00 -> mañana 08:00 para los primeros 8 usuarios de Sistemas
  // (empieza temprano para que en la demo ya se vea "vigente" a cualquier hora)
  const manana = ahoraLocal(new Date(Date.now() + 24 * 3600e3)).slice(0, 10);
  const permisos = usuarios.filter(u => u.carrera_id === 1).slice(0, 8).map((u, k) => ({
    id: k + 1, nombre: 'Hackatón LinceCode', desde: `${hoyLocal()} 06:00:00`, hasta: `${manana} 08:00:00`,
    usuario_id: u.id, autorizado_por: 'Coordinación de Sistemas'
  }));
  let sigPermiso = permisos.length + 1;

  /** Permiso vigente AHORA de un usuario, o null */
  function permisoVigente(uid) {
    const ahora = ahoraLocal();
    return permisos.find(p => p.usuario_id === uid && p.desde <= ahora && ahora <= p.hasta) || null;
  }

  // ---------- Eventos de hoy generados (para gráficas e historial) ----------
  const eventos = [];       // {id, usuario_id, tipo, origen, kiosco_id, fecha_hora}
  const dentro = new Set(); // ids de usuarios cuyo último evento de hoy es ingreso
  let sigId = 1;
  const intentos = [];      // rechazos/repetidos simulados

  function fechaHoy(h, m, s) {
    const p = n => String(n).padStart(2, '0');
    return `${hoyLocal()} ${p(h)}:${p(m)}:${p(s)}`;
  }

  (function generarHistorial() {
    const horaActual = parseInt(ahoraLocal().slice(11, 13), 10);
    // Pesos por hora para que se noten las horas pico (7, 9, 13, 16)
    const pesos = { 6: 2, 7: 9, 8: 5, 9: 7, 10: 3, 11: 3, 12: 4, 13: 8, 14: 4, 15: 3, 16: 6, 17: 3, 18: 2, 19: 2, 20: 1 };
    for (let h = 6; h <= Math.min(horaActual, 20); h++) {
      const n = pesos[h] || 1;
      for (let k = 0; k < n; k++) {
        const u = usuarios[Math.floor(Math.random() * usuarios.length)];
        if (u.estatus === 'inactivo') continue;
        const tipo = dentro.has(u.id) ? 'egreso' : 'ingreso';
        tipo === 'ingreso' ? dentro.add(u.id) : dentro.delete(u.id);
        eventos.push({
          id: sigId++, usuario_id: u.id, tipo, origen: 'kiosco',
          kiosco_id: kioscos[k % 2], fecha_hora: fechaHoy(h, (k * 7) % 60, (k * 13) % 60)
        });
      }
    }
    eventos.sort((a, b) => a.fecha_hora.localeCompare(b.fecha_hora));
  })();

  // ---------- Cálculos con la misma forma que la API ----------
  function aforo() {
    const porCarrera = {}, porGrupo = {};
    for (const c of carreras) porCarrera[c.nombre] = 0;
    for (const id of dentro) {
      const u = usuarios.find(x => x.id === id);
      porCarrera[u.carrera] = (porCarrera[u.carrera] || 0) + 1;
      const g = u.grupo || 'Personal';
      porGrupo[g] = (porGrupo[g] || 0) + 1;
    }
    return {
      total: dentro.size,
      con_permiso: [...dentro].filter(id => permisoVigente(id)).length,
      por_carrera: Object.entries(porCarrera).map(([carrera, n]) => ({ carrera, dentro: n })),
      por_grupo: Object.entries(porGrupo).sort().map(([grupo, n]) => ({ grupo, dentro: n }))
    };
  }

  function eventosFiltrados(q) {
    return eventos
      .map(e => {
        const u = usuarios.find(x => x.id === e.usuario_id);
        return { id: e.id, nombre: u.nombre, carrera: u.carrera, tipo: e.tipo, origen: e.origen,
          kiosco_id: e.kiosco_id, fecha_hora: e.fecha_hora, _uid: u.id };
      })
      .filter(e => !q.desde || e.fecha_hora.slice(0, 10) >= q.desde)
      .filter(e => !q.hasta || e.fecha_hora.slice(0, 10) <= q.hasta)
      .filter(e => !q.carrera || e.carrera === q.carrera)
      .filter(e => !q.usuario_id || String(e._uid) === String(q.usuario_id))
      .map(({ _uid, ...resto }) => resto)
      .reverse();
  }

  function usuarioPublico(u) {
    return u && { id: u.id, nombre: u.nombre, foto_url: u.foto_url, carrera: u.carrera, grupo: u.grupo, tipo: u.tipo };
  }

  // ---------- "Router" falso: recibe método + ruta como fetch ----------
  function responder(metodo, ruta, cuerpo) {
    const url = new URL(ruta, location.origin);
    const q = Object.fromEntries(url.searchParams);
    const p = url.pathname;

    if (metodo === 'GET' && p === '/api/aforo') return aforo();
    if (metodo === 'GET' && p === '/api/eventos') return eventosFiltrados(q);
    if (metodo === 'GET' && p === '/api/usuarios') return usuarios.map(u => ({ ...u }));

    if (metodo === 'POST' && p === '/api/usuarios') {
      const c = carreras.find(x => x.id === Number(cuerpo.carrera_id));
      const nuevo = { ...cuerpo, id: usuarios.length + 1, carrera: c ? c.nombre : null };
      usuarios.push(nuevo);
      return nuevo;
    }
    const mPut = p.match(/^\/api\/usuarios\/(\d+)$/);
    if (metodo === 'PUT' && mPut) {
      const u = usuarios.find(x => x.id === Number(mPut[1]));
      if (!u) throw new Error('Usuario no encontrado');
      Object.assign(u, cuerpo);
      const c = carreras.find(x => x.id === Number(u.carrera_id));
      u.carrera = c ? c.nombre : u.carrera;
      return u;
    }

    // Reponer credencial: código nuevo; el anterior deja de servir
    const mRep = p.match(/^\/api\/usuarios\/(\d+)\/reponer$/);
    if (metodo === 'POST' && mRep) {
      const u = usuarios.find(x => x.id === Number(mRep[1]));
      if (!u) throw new Error('Usuario no encontrado');
      u.codigo_credencial = codigoAleatorio();
      return { codigo_credencial: u.codigo_credencial };
    }

    if (metodo === 'GET' && p === '/api/permisos') {
      return permisos.map(pm => ({ ...pm, usuario: usuarios.find(u => u.id === pm.usuario_id)?.nombre }));
    }
    if (metodo === 'POST' && p === '/api/permisos') {
      // El servidor real expande carrera/grupo a una fila por persona; aquí hacemos lo mismo
      let ids = (cuerpo.usuario_ids || []).map(Number);
      if (!ids.length) ids = usuarios.filter(u =>
        (!cuerpo.carrera_id || u.carrera_id === Number(cuerpo.carrera_id)) &&
        (!cuerpo.grupo || u.grupo === cuerpo.grupo)).map(u => u.id);
      for (const id of ids) permisos.push({ id: sigPermiso++, nombre: cuerpo.nombre, desde: cuerpo.desde,
        hasta: cuerpo.hasta, usuario_id: id, autorizado_por: cuerpo.autorizado_por || 'Dashboard' });
      return { creados: ids.length };
    }

    if (metodo === 'GET' && p === '/api/dentro-sin-permiso') {
      return [...dentro].filter(id => !permisoVigente(id)).map(id => {
        const u = usuarios.find(x => x.id === id);
        const ult = [...eventos].reverse().find(e => e.usuario_id === id);
        return { id, nombre: u.nombre, carrera: u.carrera, grupo: u.grupo, tipo: u.tipo, foto_url: u.foto_url,
          desde: ult?.fecha_hora };
      });
    }

    if (metodo === 'POST' && p === '/api/cierre') {
      // Solo a quien está dentro y NO tiene permiso vigente
      const sinPermiso = [...dentro].filter(id => !permisoVigente(id));
      const cerrados = sinPermiso.length;
      for (const id of sinPermiso) {
        eventos.push({ id: sigId++, usuario_id: id, tipo: 'egreso', origen: 'automatico',
          kiosco_id: null, fecha_hora: ahoraLocal() });
        dentro.delete(id);
      }
      setTimeout(() => _handlers.aforo && _handlers.aforo(aforo()), 50);
      return { cerrados };
    }

    if (metodo === 'GET' && p === '/api/anomalias') {
      const u = usuarios[4];
      return [
        { tipo: 'horario_nocturno', mensaje: 'Acceso a las 23:41 (fuera de 06:00–22:00)', usuario: u.nombre, fecha_hora: fechaHoy(0, 41, 5) },
        { tipo: 'kioscos_distintos', mensaje: 'Escaneada en K-PUERTA1 y K-PUERTA2 con 48 s de diferencia', usuario: usuarios[9].nombre, fecha_hora: fechaHoy(9, 12, 30) },
        { tipo: 'permiso_vencido', mensaje: 'Su permiso "Feria de ciencias" venció a las 07:00 y sigue dentro', usuario: usuarios[12].nombre, fecha_hora: fechaHoy(7, 0, 0) }
      ];
    }

    if (metodo === 'POST' && p === '/api/chat') {
      const preg = (cuerpo.pregunta || '').toLowerCase();
      const a = aforo();
      const c = a.por_carrera.find(x => preg.includes(x.carrera.split(' ')[0].toLowerCase()));
      const respuesta = c
        ? `(Modo demo) En ${c.carrera} hay ${c.dentro} persona(s) dentro ahora mismo.`
        : `(Modo demo) Ahora hay ${a.total} personas dentro del plantel. Cuando el servidor esté listo, responderá la IA real.`;
      return { respuesta };
    }

    throw new Error(`Mock: ruta no simulada ${metodo} ${p}`);
  }

  // ---------- Simulador de Socket.IO ----------
  let _handlers = {};
  function simular(handlers) {
    _handlers = handlers;
    setInterval(() => {
      const u = usuarios[Math.floor(Math.random() * usuarios.length)];
      const r = Math.random();
      const fh = ahoraLocal();
      const kiosco_id = kioscos[Math.floor(Math.random() * 2)];
      let ev;

      if (u.estatus === 'inactivo' || r < 0.06) {
        ev = { resultado: 'rechazado', color: 'rojo', motivo: 'inactiva', usuario: usuarioPublico(u) };
      } else if (r < 0.10) {
        ev = { resultado: 'rechazado', color: 'rojo', motivo: 'no_registrada', usuario: null };
      } else if (r < 0.20) {
        ev = { resultado: 'repetido', color: 'ambar', motivo: 'repetido', usuario: usuarioPublico(u) };
      } else if (r < 0.26 && dentro.has(u.id)) {
        ev = { resultado: 'rechazado', color: 'rojo', motivo: 'ya_dentro', usuario: usuarioPublico(u) };
      } else {
        // Acceso válido: alterna ingreso / egreso (regla 2)
        const tipo = dentro.has(u.id) ? 'egreso' : 'ingreso';
        tipo === 'ingreso' ? dentro.add(u.id) : dentro.delete(u.id);
        eventos.push({ id: sigId++, usuario_id: u.id, tipo, origen: 'kiosco', kiosco_id, fecha_hora: fh });
        const externo = u.estatus === 'externo';
        ev = { resultado: tipo, color: externo ? 'ambar' : 'verde', motivo: externo ? 'externo' : null, usuario: usuarioPublico(u) };
      }

      ev.fecha_hora = fh;
      ev.kiosco_id = kiosco_id;
      // Campo nuevo del contrato: permiso: null | {nombre, hasta}
      const pm = ev.usuario ? permisoVigente(u.id) : null;
      ev.permiso = pm ? { nombre: pm.nombre, hasta: pm.hasta } : null;
      if (ev.resultado === 'rechazado' || ev.resultado === 'repetido') {
        intentos.push({ codigo_leido: u.codigo_credencial, motivo: ev.motivo, fecha_hora: fh });
      }

      handlers.evento && handlers.evento(ev);
      handlers.aforo && handlers.aforo(aforo());

      // De vez en cuando, una alerta de "anomalía" como las que mandaría ia.js
      if (Math.random() < 0.05 && handlers.alerta) {
        const opciones = [
          { tipo: 'kioscos_distintos', mensaje: 'Misma credencial en dos kioscos en menos de 2 min' },
          { tipo: 'noche_sin_permiso', mensaje: 'Se le marcó salida automática a las 00:00 y ahora escanea en modo salida' }
        ];
        handlers.alerta({ ...opciones[Math.floor(Math.random() * 2)], usuario: u.nombre, fecha_hora: fh });
      }
    }, 3500);
  }

  return { responder, simular };
})();
