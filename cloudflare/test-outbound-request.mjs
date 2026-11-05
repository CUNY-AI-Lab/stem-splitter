// Wrangler's test bridge passes a Request as fetch(url, init). MSW copies init
// by spreading it, which loses Request prototype properties such as headers.
// Preserve the original values explicitly; this does not replace responses.
export function preserveWorkerRequestInit() {
  const previous = globalThis.fetch;
  globalThis.fetch = (input, init) => previous(input, init && typeof init.url === 'string'
    ? { method: init.method, headers: init.headers, body: init.body,
      redirect: init.redirect, signal: init.signal, duplex: 'half' }
    : init);
  return () => { globalThis.fetch = previous; };
}
