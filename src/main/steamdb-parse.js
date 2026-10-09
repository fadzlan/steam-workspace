'use strict';
// Pure helpers for SteamDB (kept separate from Electron so they can be unit tested).
// Formats are taken from SteamDB's own front-end code (app.js / hover.js).

// GET /api/GetPriceHistory/?appid=&cc=  ->  {success, data:{history:[{x: ms, y: price, d: discount %, f: "RM70.60"}]}}
// Returns {history:[[ms, cents]], low, lowAt}. y is in currency units; points with no price (y = 0) are dropped.
function parseHistory(j) {
  const raw = j && j.success !== false && j.data && Array.isArray(j.data.history) ? j.data.history : null;
  if (!raw) return null;
  const history = raw
    .map((p) => (Array.isArray(p) ? [Number(p[0]), Math.round(Number(p[1]) * 100)] : [Number(p.x), Math.round(Number(p.y) * 100)]))
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

module.exports = { parseHistory, microtrailerUrl, CHALLENGE_TITLE };
