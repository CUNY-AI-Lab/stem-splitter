// The same assets run at the standalone Worker and at the Tools mount.
// Resolve application-owned URLs explicitly; external, blob and data URLs stay intact.
(() => {
  const source = new URL(document.currentScript.src);
  const base = source.pathname === '/stem-splitter/app-path.js' ? '/stem-splitter' : '';
  function path(value) {
    if (!base || typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return value;
    if (value === '/auth/logout' || value === base || value.startsWith(`${base}/`)) return value;
    return base + value;
  }
  window.StemPath = Object.assign(path, { base });
  window.StemFetch = (input, options) => window.fetch(typeof input === 'string' ? path(input) : input, options);
})();
