/* =====================================================================
   api.js — Único punto de contacto entre el dashboard y el servidor.
   - Intenta siempre el servidor real (mismo origen: el servidor Express
     sirve la carpeta dashboard/).
   - Si el servidor no responde (o la ruta aún no existe -> 404), usa
     mock.js para que la interfaz se pueda probar sin backend.
   - Forzar datos falsos: abrir con ?mock=1  (ej. index.html?mock=1)
   ===================================================================== */

const API = (() => {
  const params = new URLSearchParams(location.search);
  let modoMock = params.get('mock') === '1' || location.protocol === 'file:';

  function marcarMock() {
    if (!modoMock) console.warn('[API] Servidor no disponible: usando datos falsos (mock.js)');
    modoMock = true;
    document.body.classList.add('modo-mock');
  }

  /* Clave de administrador (ADMIN_KEY del .env del servidor).
     Las rutas que cambian datos (usuarios, permisos, cierre) exigen la
     cabecera x-admin-key. Se pide una vez y se guarda solo en esta pestaña
     (sessionStorage): al cerrar el navegador hay que escribirla de nuevo. */
  const CLAVE = 'admin_key';
  function leerClave() { try { return sessionStorage.getItem(CLAVE) || ''; } catch { return ''; } }
  function guardarClave(v) { try { v ? sessionStorage.setItem(CLAVE, v) : sessionStorage.removeItem(CLAVE); } catch {} }

  /** Petición genérica. Devuelve el JSON ya parseado. */
  async function pedir(metodo, ruta, cuerpo, reintento = false) {
    if (!modoMock) {
      try {
        const headers = {};
        if (cuerpo) headers['Content-Type'] = 'application/json';
        if (metodo !== 'GET' && leerClave()) headers['x-admin-key'] = leerClave();
        const r = await fetch(ruta, {
          method: metodo,
          headers,
          body: cuerpo ? JSON.stringify(cuerpo) : undefined
        });
        // 403 = falta la clave de administrador o es incorrecta: pedirla y reintentar una vez
        if (r.status === 403 && !reintento) {
          const clave = prompt(leerClave()
            ? 'La clave de administrador no es correcta. Escríbela de nuevo:'
            : 'Esta acción requiere la clave de administrador (ADMIN_KEY del servidor):');
          if (!clave) throw new Error('Se necesita la clave de administrador');
          guardarClave(clave.trim());
          return pedir(metodo, ruta, cuerpo, true);
        }
        if (r.status === 403) guardarClave('');
        if (r.status === 404 || r.status === 405 || r.status === 501) {
          // La ruta/método todavía no la implementa el backend: solo esta llamada va al mock
          console.warn('[API] 404 en', ruta, '-> respuesta simulada');
          return Mock.responder(metodo, ruta, cuerpo);
        }
        const datos = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(datos.error || datos.mensaje || `Error ${r.status}`);
        return datos;
      } catch (e) {
        // TypeError = no hubo conexión con el servidor
        if (e instanceof TypeError) marcarMock();
        else throw e;
      }
    }
    return Mock.responder(metodo, ruta, cuerpo);
  }

  /** Arma "?a=1&b=2" ignorando filtros vacíos */
  function qs(obj = {}) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) if (v !== '' && v != null) p.set(k, v);
    const s = p.toString();
    return s ? '?' + s : '';
  }

  /**
   * Conecta los eventos en vivo.
   * handlers = { evento(fn), alerta(fn), aforo(fn), estado(fn conectado:boolean) }
   */
  function conectar(handlers) {
    if (!modoMock && typeof io === 'function') {
      const socket = io();   // se conecta al mismo servidor que sirvió la página
      socket.on('connect', () => handlers.estado && handlers.estado(true));
      socket.on('disconnect', () => handlers.estado && handlers.estado(false));
      socket.on('evento', d => handlers.evento && handlers.evento(d));
      socket.on('alerta', d => handlers.alerta && handlers.alerta(d));
      socket.on('aforo', d => handlers.aforo && handlers.aforo(d));
      return socket;
    }
    marcarMock();
    handlers.estado && handlers.estado(true);
    Mock.simular(handlers);
    return null;
  }

  return {
    get mock() { return modoMock; },
    marcarMock,
    aforo:       ()         => pedir('GET',  '/api/aforo'),
    eventos:     (filtros)  => pedir('GET',  '/api/eventos' + qs(filtros)),
    usuarios:    ()         => pedir('GET',  '/api/usuarios'),
    crearUsuario:(datos)    => pedir('POST', '/api/usuarios', datos),
    editarUsuario:(id, d)   => pedir('PUT',  '/api/usuarios/' + id, d),
    reponer:     (id)       => pedir('POST', `/api/usuarios/${id}/reponer`, {}),
    permisos:    ()         => pedir('GET',  '/api/permisos'),
    crearPermiso:(datos)    => pedir('POST', '/api/permisos', datos),
    dentroSinPermiso: ()    => pedir('GET',  '/api/dentro-sin-permiso'),
    cierre:      ()         => pedir('POST', '/api/cierre', {}),
    anomalias:   ()         => pedir('GET',  '/api/anomalias'),
    chat:        (pregunta) => pedir('POST', '/api/chat', { pregunta }),
    conectar
  };
})();
