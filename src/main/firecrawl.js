'use strict';
const http = require('./http');
const { parseHistory } = require('./steamdb-parse');
const log = require('./log');

// Optional SteamDB source: Firecrawl (https://firecrawl.dev) fetches SteamDB pages from its own
// infrastructure, so there is no browser window and no Cloudflare check on this machine.
// Costs 1 credit per game for the app page (lowest price ever + preview video); price history needs a method found by probe().
const HOST = 'api.firecrawl.dev';

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
  async scrape(url, { headers, formats = ['rawHtml'], actions, signal } = {}) {
    const key = this.getKey();
    if (!key) throw Object.assign(new Error('No Firecrawl API key set (Settings).'), { fatal: true });
    const where = (() => { try { return new URL(url).pathname; } catch (_) { return url; } })();
    let res;
    try {
      res = await this.t.run(HOST, 1500, () => http.fetchNow(`https://${HOST}/v2/scrape`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formats, headers, actions, maxAge: 0 }),
        signal,
      }), signal);
    } catch (e) {
      if (!(signal && signal.aborted) && e.message !== 'cancelled') log.warn(`Firecrawl network error for ${where}: ${e.message}`);
      throw e;
    }
    const fail = (msg, extra = {}) => { log.warn(`Firecrawl ${res.status} for ${where}: ${msg}`); return Object.assign(new Error(msg), extra); };
    if (res.status === 401 || res.status === 403) throw fail('Firecrawl rejected the API key (check Settings).', { fatal: true });
    if (res.status === 402) throw fail('Firecrawl account is out of credits.', { fatal: true });
    if (res.status === 429) { this.t.penalize(HOST, 30000); throw fail('Firecrawl rate limit reached, try again shortly.'); }
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || j.success === false) throw fail(`Firecrawl error ${res.status}${j && j.error ? ': ' + j.error : ''}`);
    const d = j.data || {};
    const js = (d.actions && d.actions.javascriptReturns) || [];
    return { text: d.rawHtml || d.html || d.markdown || '', status: (d.metadata && d.metadata.statusCode) || 200, js: js.map((x) => x && x.value) };
  }

  // --- price history (SteamDB's /api/GetPriceHistory/ only answers browser-like XHR requests) -------------------
  // Method 'js': load the app page and run the same fetch() inside it (Firecrawl "executeJavascript" action).
  // Method 'headers': ask Firecrawl to request the JSON URL directly with the XHR headers.
  // Which one (if any) works for an account is found once by probe() and saved in settings.fcHistoryMode.
  _histScript(id, cc) {
    return `(async () => { const r = await fetch('/api/GetPriceHistory/?appid=${id}&cc=${encodeURIComponent(cc)}', { credentials: 'include', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } }); return await r.text(); })()`;
  }

  _histFromJs(res) {
    for (const v of res.js || []) {
      try { const h = parseHistory(typeof v === 'string' ? JSON.parse(v) : v); if (h) return h; } catch (_) { /* not JSON */ }
    }
    return null;
  }

  async _historyHeaders(id, cc, signal) {
    const r = await this.scrape(`https://steamdb.info/api/GetPriceHistory/?appid=${id}&cc=${encodeURIComponent(cc)}`, {
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Referer: `https://steamdb.info/app/${id}/`, 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin' },
      signal,
    });
    return parseHistory(jsonFromBody(r.text));
  }

  async _pageWithHistoryJs(id, cc, signal) {
    return this.scrape(`https://steamdb.info/app/${id}/`, { formats: ['markdown'], actions: [{ type: 'wait', milliseconds: 1500 }, { type: 'executeJavascript', script: this._histScript(id, cc) }], signal });
  }

  /** Try the history methods once. -> {mode: 'js'|'headers'|'none', message} (uses up to ~3 credits). */
  async probe(cc = 'us') {
    const id = 1672500;
    try {
      const r = await this._pageWithHistoryJs(id, cc);
      const h = this._histFromJs(r);
      log.info(`Firecrawl probe js: ${h ? h.history.length + ' points' : 'no history'} (js returns: ${JSON.stringify(r.js || []).slice(0, 160)})`);
      if (h) return { mode: 'js', message: `Price history works (browser script, ${h.history.length} points).` };
    } catch (e) { if (e.fatal) throw e; log.info(`Firecrawl probe js failed: ${e.message}`); }
    try {
      const h = await this._historyHeaders(id, cc);
      log.info(`Firecrawl probe headers: ${h ? h.history.length + ' points' : 'no history'}`);
      if (h) return { mode: 'headers', message: `Price history works (direct request, ${h.history.length} points). Costs 2 credits per game.` };
    } catch (e) { if (e.fatal) throw e; log.info(`Firecrawl probe headers failed: ${e.message}`); }
    return { mode: 'none', message: 'SteamDB did not return price history through Firecrawl. Games will show the lowest price ever and the preview only.' };
  }

  // Same result shape as SteamDB.fetchApp, plus allTimeLow (cents) from SteamDB's currency table, matched to the
  // game's current Steam price (`hint.price`, e.g. "RM79.60").
  async fetchApp(appid, cc, signal, hint = {}) {
    const id = Number(appid);
    let page, hist = null;
    if (hint.mode === 'js') {
      page = await this._pageWithHistoryJs(id, cc, signal);
      hist = this._histFromJs(page);
    } else {
      page = await this.scrape(`https://steamdb.info/app/${id}/`, { formats: ['markdown'], signal });
      if (hint.mode === 'headers') hist = await this._historyHeaders(id, cc, signal).catch((e) => { if (e.fatal) throw e; log.info(`Firecrawl SteamDB ${id}: history request failed: ${e.message}`); return null; });
    }
    const gif = findMicrotrailer(page.text);
    const lowest = lowestFromPage(page.text, hint.price);
    // anonymous SteamDB history covers ~2 years; a history that long was probably cut off
    const more = !!(hist && Date.now() - hist.history[0][0] > 700 * 864e5);
    log.info(`Firecrawl SteamDB ${id}: history=${hist ? hist.history.length + ' points' : 'none'}${more ? ' (2-year window)' : ''} lowestEver=${lowest ? lowest.cents : 'none'} preview=${gif ? 'yes' : 'no'}`);
    if (!lowest) log.info(`Firecrawl SteamDB ${id}: no currency row matched "${hint.price || ''}"`);
    return { history: hist ? hist.history : null, low: hist ? hist.low : lowest ? lowest.cents : null, lowAt: hist ? hist.lowAt : null, more, allTime: !hist && !!lowest, allTimeLow: lowest ? lowest.cents : null, gif };
  }

  // Settings "Test" button: one request that proves the key works and SteamDB's page is readable.
  async test() {
    const page = await this.scrape('https://steamdb.info/app/1672500/', { formats: ['markdown'] });
    const readable = /Lowest Recorded Price/i.test(page.text);
    return readable
      ? { ok: true, message: `Works: SteamDB's page was readable${findMicrotrailer(page.text) ? ' (preview video found)' : ''}.` }
      : { ok: false, message: `Key accepted, but SteamDB's page was not readable (HTTP ${page.status}, ${String(page.text).length} characters).` };
  }
}

// "RM79.60", "Rp 239600", "1.234,56 €", "¥ 3388", "396000₫"  ->  number (decimal separator = the last . or , followed by 1-2 digits)
function parsePrice(str) {
  const m = String(str).replace(/[\u00a0\s]/g, '').match(/[\d.,]*\d/);
  if (!m) return null;
  let t = m[0];
  const last = Math.max(t.lastIndexOf('.'), t.lastIndexOf(','));
  const decimals = last >= 0 && t.length - last - 1 <= 2 && t.length - last - 1 >= 1 ? t.slice(last + 1) : '';
  const int = (decimals ? t.slice(0, last) : t).replace(/[.,]/g, '');
  return Number(decimals ? `${int}.${decimals}` : int);
}

// The cells of a markdown table row, minus the leading/trailing pipes.
const cells = (row) => row.split('|').slice(1, -1).map((c) => c.trim());
const norm = (x) => String(x).replace(/[\u00a0\s]/g, '');
const symbols = (x) => norm(x).replace(/[\d.,%\-]/g, '');
const digits = (x) => norm(x).replace(/\D/g, '');

// Find the currency row whose "current price" cell equals the game's current Steam price, and read the
// lowest recorded price (last cell, e.g. "-60% RM79.60") from it. -> {cents, text} | null
function lowestFromPage(md, price) {
  if (!price) return null;
  const want = { sym: symbols(price), dig: digits(price) };
  for (const line of String(md).split('\n')) {
    if (!line.startsWith('|') || !/static\/country\//.test(line)) continue;
    const c = cells(line);
    if (c.length < 3) continue;
    const cur = c[1].replace(/^-?\d+%/, '');
    if (digits(cur) !== want.dig || symbols(cur) !== want.sym) continue;
    const lowText = c[c.length - 1].replace(/^-?\d+%/, '').trim();
    const v = parsePrice(lowText);
    if (v != null && v >= 0) return { cents: Math.round(v * 100), text: lowText };
  }
  return null;
}

module.exports = { Firecrawl, findMicrotrailer, jsonFromBody, parsePrice, lowestFromPage };
