// Shared by the smoke test and the screenshot script: the Tampermonkey API as stubs, and a bridge that sends
// GM_xmlhttpRequest to a real second-chair server through Node, the way Tampermonkey bypasses CORS.
const http = require('http');

/** One HTTP request to the server on `port`; resolves { ok: false } when nothing answers. */
function nodeRequest(port, { method, url, headers, data }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ host: '127.0.0.1', port, method, path: u.pathname + u.search, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, responseText: body }));
    });
    req.on('error', () => resolve({ ok: false }));
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Installs the GM_* stubs on a page before its scripts run. `store` is the starting GM storage as a JSON string,
 * or null. Port 0 means no server: every request fails. The page exposes `window.__store` and `window.__clip`.
 */
async function installGm(page, port, store) {
  await page.exposeFunction('__gmx', (req) => (port ? nodeRequest(port, req) : Promise.resolve({ ok: false })));
  await page.addInitScript((s) => {
    const store = s ? JSON.parse(s) : {};
    window.GM_getValue = (k, d) => (k in store ? store[k] : d);
    window.GM_setValue = (k, v) => { store[k] = v; };
    window.GM_deleteValue = (k) => { delete store[k]; };
    window.GM_setClipboard = (t) => { window.__clip = t; };
    window.GM_xmlhttpRequest = (o) => {
      window.__gmx({ method: o.method, url: o.url, headers: o.headers, data: o.data }).then((r) => (r.ok ? o.onload({ status: r.status, responseText: r.responseText }) : o.onerror()));
    };
    window.__store = store;
  }, store ?? null);
}

module.exports = { nodeRequest, installGm };
