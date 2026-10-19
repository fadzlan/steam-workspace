'use strict';
// Pure helpers for SteamDB (kept separate from Electron so they can be unit tested).
// Formats are taken from SteamDB's own front-end code (app.js / hover.js).

// GET /api/GetPriceHistory/?appid=&cc=  ->  {success, data:{history:[{x: ms, y: price, d: discount %, f: "RM70.60"}]}}
// Returns {history:[[ms, cents, discount%]], low, lowAt}. y is in currency units; points with no price (y = 0) are dropped.
function parseHistory(j) {
  const raw = j && j.success !== false && j.data && Array.isArray(j.data.history) ? j.data.history : null;
  if (!raw) return null;
  const history = raw
    .map((p) => (Array.isArray(p) ? [Number(p[0]), Math.round(Number(p[1]) * 100)] : [Number(p.x), Math.round(Number(p.y) * 100), Number(p.d) || 0]))
    .filter((p) => p[0] > 0 && p[1] > 0);
  if (!history.length) return null;
  let low = history[0];
  for (const p of history) if (p[1] < low[1]) low = p;
  return { history, low: low[1], lowAt: low[0] };
}

// data-microtrailer on SteamDB's hover card: {"video":{"video/webm":"<path>","video/mp4":"<path>"},"time":123}
// -> playable URL on the video CDN (webm preferred, Chromium plays it everywhere).
function microtrailerUrl(videoCdn, json) {
  let m;
  try { m = typeof json === 'string' ? JSON.parse(json) : json; } catch (_) { return null; }
  const v = m && m.video;
  if (!v || !videoCdn) return null;
  const path = v['video/webm'] || v['video/mp4'];
  if (!path) return null;
  return `${videoCdn}store_trailers/${path}${m.time ? `?t=${m.time}` : ''}`;
}

const CHALLENGE_TITLE = /just a moment|attention required|checking your browser|verify you are human/i;
// true while Cloudflare's check is on the page (evaluated inside the page)
const CHALLENGE_SCRIPT = `!!document.querySelector('#challenge-form, #challenge-running, .cf-turnstile, [name="cf-turnstile-response"]')`;

// Runs inside a loaded https://steamdb.info/app/<id>/ page: SteamDB's own two XHR endpoints (so the Cloudflare
// cookie and referer apply): price history, and the hover card holding the micro-trailer.
function appPageScript(appid, cc) {
  const id = Number(appid);
  return `(async () => {
    const out = { url: location.href, title: document.title, videoCdn: document.body.dataset.videoCdn || '' };
    const get = (u, accept) => fetch(u, { credentials: 'include', headers: { Accept: accept, 'X-Requested-With': 'XMLHttpRequest' } });
    try {
      const h = await get('/api/GetPriceHistory/?appid=${id}&cc=${encodeURIComponent(cc)}', 'application/json');
      out.history = { status: h.status, more: h.headers.has('X-SteamDB-History-More'), body: await h.text() };
    } catch (e) { out.historyErr = String(e); }
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const v = await get('/api/RenderAppHover/?appid=${id}', 'text/html');
      const t = await v.text();
      const el = new DOMParser().parseFromString(t, 'text/html').querySelector('.hover_video');
      out.hover = { status: v.status, length: t.length, microtrailer: (el && el.dataset.microtrailer) || null };
    } catch (e) { out.hoverErr = String(e); }
    return out;
  })()`;
}

// What appPageScript returned -> the fetchApp result. `who` labels the log lines ("SteamDB", "Browser Use SteamDB").
function readAppPage(who, appid, r, log) {
  let hist = null;
  try { hist = r.history ? parseHistory(JSON.parse(r.history.body)) : null; } catch (e) { log.warn(`${who} history for ${appid}: ${e.message}`); }
  const video = r.hover && r.hover.microtrailer ? microtrailerUrl(r.videoCdn, r.hover.microtrailer) : null;
  log.info(`${who} ${appid}: history=${hist ? hist.history.length + ' points' : 'none'}${r.history && r.history.more ? ' (truncated: 2-year history)' : ''} preview=${video ? 'yes' : 'no'}`);
  if (!hist || !video) {
    log.info(`${who} ${appid} debug: ${JSON.stringify({
      page: { url: r.url, title: r.title },
      history: r.history ? { status: r.history.status, length: r.history.body.length, head: r.history.body.slice(0, 300) } : r.historyErr,
      hover: r.hover ? { status: r.hover.status, length: r.hover.length, microtrailer: r.hover.microtrailer } : r.hoverErr,
    })}`);
  }
  return { history: hist ? hist.history : null, low: hist ? hist.low : null, lowAt: hist ? hist.lowAt : null, more: !!(r.history && r.history.more), gif: video };
}

module.exports = { parseHistory, microtrailerUrl, CHALLENGE_TITLE, CHALLENGE_SCRIPT, appPageScript, readAppPage };
