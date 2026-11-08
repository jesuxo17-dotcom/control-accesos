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

  /** Petición genérica con la sesión del panel (sesion.js). Devuelve el JSON ya parseado.
      401/403 = la sesión venció o no existe: de vuelta a la página de inicio de sesión. */
  async function pedir(metodo, ruta, cuerpo) {
    if (!modoMock) {
      try {
        const headers = { ...Sesion.cabecera() };
        if (cuerpo) headers['Content-Type'] = 'application/json';
        const r = await fetch(ruta, {
          method: metodo,
          headers,
          body: cuerpo ? JSON.stringify(cuerpo) : undefined
        });
        if (r.status === 401 || r.status === 403) {
          Sesion.vencida();
          throw new Error('Tu sesión terminó: vuelve a iniciar sesión');
        }
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
      const socket = io({ auth: { token: Sesion.token() } });   // mismo servidor; la sesión abre los datos en vivo
      socket.on('connect_error', e => { if (/no autorizado/.test(e.message)) Sesion.vencida(); });
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
    chat:        (pregunta, historial) => pedir('POST', '/api/chat', { pregunta, historial }),
    tutoresPendientes: ()   => pedir('GET',  '/api/tutores/pendientes'),
    aprobarVinculo: (id)    => pedir('POST', `/api/tutores/hijos/${id}/aprobar`, { identidad_y_parentesco_verificados: true }),
    rechazarVinculo: (id)   => pedir('POST', `/api/tutores/hijos/${id}/rechazar`, {}),
    conectar
  };
})();
