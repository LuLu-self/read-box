// GitHub access for the board: settings in localStorage (readbox.* keys only, never GitHub Box's
// repobox.*), reads from the private library repo, and the few writes the board makes.

const API = 'https://api.github.com/repos';
const CFG_KEY = 'readbox.cfg';
export const DEFAULT_REPO = 'LuLu-self/read-box-library';
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export function loadCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY));
    return c && typeof c.token === 'string' && REPO_RE.test(c.repo || '') ? c : null;
  } catch { return null; }
}

export function saveCfg(repo, token) {
  repo = String(repo || '').trim();
  token = String(token || '').trim();
  if (!REPO_RE.test(repo) || !token) return false;
  try { localStorage.setItem(CFG_KEY, JSON.stringify({ repo, token })); return true; } catch { return false; }
}

export function clearCfg() {
  try { localStorage.removeItem(CFG_KEY); } catch { /* storage blocked */ }
}

function headers(cfg, accept = 'application/vnd.github+json') {
  return { Authorization: `Bearer ${cfg.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

// no-cache: the API answers with max-age=60, which would hide what a run just published.
export async function getText(cfg, path) {
  try {
    const res = await fetch(`${API}/${cfg.repo}/contents/${encPath(path)}`,
      { headers: headers(cfg, 'application/vnd.github.raw+json'), cache: 'no-cache' });
    return { status: res.status, text: res.ok ? await res.text() : null };
  } catch { return { status: 0, text: null }; }
}

export async function getJson(cfg, path) {
  const r = await getText(cfg, path);
  if (r.text == null) return { status: r.status, data: null };
  try { return { status: r.status, data: JSON.parse(r.text) }; } catch { return { status: -1, data: null }; }
}

// Private-repo images cannot be <img src>'d directly; fetch with the token and hand out a blob URL.
export async function getBlobUrl(cfg, path) {
  try {
    const res = await fetch(`${API}/${cfg.repo}/contents/${encPath(path)}`,
      { headers: headers(cfg, 'application/vnd.github.raw+json') });
    if (!res.ok) return null;
    const blob = await res.blob();
    return /^image\/(jpeg|png|webp)$/.test(blob.type) || blob.type === 'application/octet-stream'
      ? URL.createObjectURL(new Blob([blob], { type: 'image/jpeg' })) : null;
  } catch { return null; }
}

export async function repoStatus(cfg) {
  try { return (await fetch(`${API}/${cfg.repo}`, { headers: headers(cfg) })).status; } catch { return 0; }
}

function b64utf8(s) {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64utf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export async function putFile(cfg, path, text, message, sha) {
  try {
    const res = await fetch(`${API}/${cfg.repo}/contents/${encPath(path)}`, {
      method: 'PUT', headers: headers(cfg),
      body: JSON.stringify({ message, content: b64utf8(text), ...(sha ? { sha } : {}) }),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, sha: body?.content?.sha, message: body?.message };
  } catch (e) { return { status: 0, ok: false, message: e.message }; }
}

// JSON file with its blob sha, for read-modify-write (state.json, taxonomy.json).
export async function getJsonWithSha(cfg, path) {
  try {
    const res = await fetch(`${API}/${cfg.repo}/contents/${encPath(path)}`, { headers: headers(cfg), cache: 'no-cache' });
    if (res.status === 404) return { status: 404, data: null, sha: null };
    if (!res.ok) return { status: res.status, data: null, sha: null };
    const body = await res.json();
    return { status: 200, data: JSON.parse(fromB64utf8(body.content)), sha: body.sha };
  } catch { return { status: 0, data: null, sha: null }; }
}

// Apply `change` to a JSON file and write it back; on a sha conflict re-read and retry once.
export async function updateJson(cfg, path, change, message, empty) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await getJsonWithSha(cfg, path);
    if (cur.status !== 200 && cur.status !== 404) return { ok: false, status: cur.status };
    const next = change(cur.data ?? structuredClone(empty));
    const res = await putFile(cfg, path, JSON.stringify(next, null, 2) + '\n', message, cur.sha);
    if (res.ok) return { ok: true, data: next };
    if (res.status !== 409 && res.status !== 422) return { ok: false, status: res.status, message: res.message };
  }
  return { ok: false, status: 409 };
}
