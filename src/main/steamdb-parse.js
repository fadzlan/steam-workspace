'use strict';
// Pure helpers for scraping SteamDB (kept separate from Electron so they can be unit tested).

// {success, data:{final:[[ms, price], ...]}} -> {history:[[ms, cents]], low, lowAt}. Prices are in currency units.
function parseHistory(j) {
  const d = (j && j.data) || {};
  const raw = Array.isArray(d.final) ? d.final : Array.isArray(d.history) ? d.history : Array.isArray(d) ? d : null;
  if (!raw || !raw.length) return null;
  const scale = Array.isArray(d.final) ? 100 : 1;
  const history = raw.map((p) => [Number(p[0]), Math.round(Number(p[1]) * scale)]).filter((p) => p[0] > 0 && p[1] >= 0);
  if (!history.length) return null;
  let low = history[0];
  for (const p of history) if (p[1] < low[1]) low = p;
  return { history, low: low[1], lowAt: low[0] };
}

// First animated preview URL on a SteamDB app page (prefers ones named hover/animated).
function findGif(html) {
  const urls = [...String(html).matchAll(/https?:\/\/[^"'\s)]+\.(?:gif|webp)(?:\?[^"'\s)]*)?/gi)].map((m) => m[0]);
  return urls.find((u) => /hover|animated/i.test(u)) || urls[0] || null;
}

const CHALLENGE_TITLE = /just a moment|attention required|checking your browser|verify you are human/i;

module.exports = { parseHistory, findGif, CHALLENGE_TITLE };
