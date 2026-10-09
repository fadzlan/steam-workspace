'use strict';
const http = require('./http');
const { parseHistory } = require('./steamdb-parse');
const log = require('./log');

// Optional SteamDB source: Firecrawl (https://firecrawl.dev) fetches SteamDB pages from its own
// infrastructure, so there is no browser window and no Cloudflare check on this machine.
// Costs about 2 credits per game (one for the history JSON, one for the app page that lists the preview video).
const HOST = 'api.firecrawl.dev';
const XHR = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

// micro-trailer links on a SteamDB app page; webm preferred (Chromium plays it everywhere)
function findMicrotrailer(text) {
  const urls = [...String(text).matchAll(/https?:\/\/[^\s)"'<>]+\/store_trailers\/[^\s)"'<>]+?microtrailer\.(webm|mp4)[^\s)"'<>]*/gi)].map((m) => m[0]);
  return urls.find((u) => /\.webm/i.test(u)) || urls[0] || null;
}

// Firecrawl wraps non-HTML bodies; get the JSON text back out.
function jsonFromBody(body) {
  let t = String(body || '').trim();
  if (t.startsWith('<')) t = t.replace(/<[^>]+>/g, '').trim();
  try { return JSON.parse(t); } catch (_) { return null; }
}

class Firecrawl {
  constructor(throttle, getKey) {
    this.t = throttle;
    this.getKey = getKey;
  }

  get enabled() { return !!this.getKey(); }

  // -> {text, status}. Throws {fatal:true} for key / credit problems so callers can stop and tell the user.
  async scrape(url, { headers, formats = ['rawHtml'], signal } = {}) {
    const key = this.getKey();
    if (!key) throw Object.assign(new Error('No Firecrawl API key set (Settings).'), { fatal: true });
    const res = await this.t.run(HOST, 1500, () => http.fetchNow(`https://${HOST}/v2/scrape`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats, headers, maxAge: 0 }),
      signal,
    }), signal);
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('Firecrawl rejected the API key (check Settings).'), { fatal: true });
    if (res.status === 402) throw Object.assign(new Error('Firecrawl account is out of credits.'), { fatal: true });
    if (res.status === 429) { this.t.penalize(HOST, 30000); throw new Error('Firecrawl rate limit reached, try again shortly.'); }
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || j.success === false) throw new Error(`Firecrawl error ${res.status}${j && j.error ? ': ' + j.error : ''}`);
    const d = j.data || {};
    return { text: d.rawHtml || d.html || d.markdown || '', status: (d.metadata && d.metadata.statusCode) || 200 };
  }

  // Same result shape as SteamDB.fetchApp.
  async fetchApp(appid, cc, signal) {
    const id = Number(appid);
    let hist = null;
    const api = await this.scrape(`https://steamdb.info/api/GetPriceHistory/?appid=${id}&cc=${encodeURIComponent(cc)}`, { headers: XHR, signal });
    const j = jsonFromBody(api.text);
    hist = parseHistory(j);
    if (!hist) log.info(`Firecrawl SteamDB ${id}: history not usable: ${JSON.stringify({ status: api.status, head: String(api.text).slice(0, 200) })}`);
    const page = await this.scrape(`https://steamdb.info/app/${id}/`, { formats: ['markdown'], signal });
    const gif = findMicrotrailer(page.text);
    // anonymous SteamDB history covers ~2 years; a history that long was probably cut off
    const more = !!(hist && Date.now() - hist.history[0][0] > 700 * 864e5);
    log.info(`Firecrawl SteamDB ${id}: history=${hist ? hist.history.length + ' points' : 'none'}${more ? ' (probably 2-year window)' : ''} preview=${gif ? 'yes' : 'no'}`);
    return { history: hist ? hist.history : null, low: hist ? hist.low : null, lowAt: hist ? hist.lowAt : null, more, gif };
  }

  // Settings "Test" button: one request, tells the user whether the key and the SteamDB history endpoint work.
  async test() {
    const api = await this.scrape('https://steamdb.info/api/GetPriceHistory/?appid=440&cc=us', { headers: XHR });
    const h = parseHistory(jsonFromBody(api.text));
    if (h) return { ok: true, message: `Works: got ${h.history.length} price points for a test game.` };
    return { ok: false, message: `Key accepted, but SteamDB's history was not readable (HTTP ${api.status}). The page preview may still work.` };
  }
}

module.exports = { Firecrawl, findMicrotrailer, jsonFromBody };
