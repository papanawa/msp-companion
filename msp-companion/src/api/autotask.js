// MSP Companion — Autotask REST API module
// Low-level HTTP primitives only. Higher-level AT functions stay in app.js
// until Phase 4 extracts them.
// Call init(getSettings) once at boot before using any other export.

let _getSettings;

export function init(getSettings) { _getSettings = getSettings; }

export function atHeaders() {
  const s = _getSettings();
  return { 'Content-Type':'application/json', 'UserName':s.atUser||'', 'Secret':s.atSecret||'', 'ApiIntegrationCode':s.atIntCode||'' };
}

export async function atFetch(path, method='GET', body=null) {
  const s = _getSettings();
  const zone = s.atZone || '14';
  const h = atHeaders();
  const opts = {
    method,
    headers: { 'Content-Type':'application/json', 'username':h.UserName, 'secret':h.Secret, 'apiintegrationcode':h.ApiIntegrationCode, 'x-at-zone':zone }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`/api/autotask?path=${encodeURIComponent(path)}&method=${method}`, opts);
  if (!res.ok) {
    const txt = await res.text();
    let err = {}; try { err = JSON.parse(txt); } catch {}
    throw new Error(`AT API ${res.status}: ${err?.errors?.[0] || txt.substring(0,120)}`);
  }
  return res.json();
}
