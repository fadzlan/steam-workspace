'use strict';
const http = require('./http');
const log = require('./log');

// Optional SteamDB source: Firecrawl (https://firecrawl.dev) fetches SteamDB pages from its own
// infrastructure, so there is no browser window and no Cloudflare check on this machine.
// Costs 1 credit per game (the app page).
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

  // Same result shape as SteamDB.fetchApp. SteamDB's history JSON refuses Firecrawl's requests (HTTP 406), so
  // this reads the app page itself: the preview video and the all-time lowest recorded price, found in the
  // currency table by matching the game's current Steam price (`hint.price`, e.g. "RM79.60").
  async fetchApp(appid, cc, signal, hint = {}) {
    const id = Number(appid);
    const page = await this.scrape(`https://steamdb.info/app/${id}/`, { formats: ['markdown'], signal });
    const gif = findMicrotrailer(page.text);
    const lowest = lowestFromPage(page.text, hint.price);
    log.info(`Firecrawl SteamDB ${id}: lowest=${lowest ? lowest.cents : 'none'} preview=${gif ? 'yes' : 'no'} (page ${String(page.text).length} chars)`);
    if (!lowest) log.info(`Firecrawl SteamDB ${id}: no currency row matched "${hint.price || ''}"`);
    return { history: null, low: lowest ? lowest.cents : null, lowAt: null, more: false, allTime: !!lowest, gif };
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
