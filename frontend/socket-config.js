(function(){
  const FALLBACK = 'http://localhost:3000';
  const globalOverride = typeof window !== 'undefined' && window.__SOCKET_URL__
    ? String(window.__SOCKET_URL__).trim()
    : '';
  const meta = typeof document !== 'undefined'
    ? document.querySelector('meta[name="socket-url"]')
    : null;
  const metaUrl = meta && typeof meta.getAttribute === 'function'
    ? (meta.getAttribute('content') || '').trim()
    : '';
  let resolved = globalOverride || metaUrl || '';
  if (!resolved) {
    if (typeof window !== 'undefined' && window.location && window.location.protocol.startsWith('http')) {
      resolved = window.location.origin;
    } else {
      resolved = FALLBACK;
    }
  }

  window.createSocket = function createSocket(options = {}) {
    const defaults = { transports: ['websocket'] };
    return io(resolved, Object.assign(defaults, options));
  };
  window.__socketBackendUrl = resolved;
})();
