'use strict';
const http = require('./http');
const { sleep } = require('./throttle');
const { appPageScript, readAppPage, CHALLENGE_TITLE, CHALLENGE_SCRIPT } = require('./steamdb-parse');
const log = require('./log');

// Optional SteamDB source: Browser Use (https://browser-use.com) runs a real Chromium in its cloud, solves
// Cloudflare's check by itself, and we drive it over the Chrome DevTools Protocol exactly like the local
// SteamDB window: one app-page load per game plus SteamDB's own price-history and hover-card requests.
// No AI agent is involved, so a game costs only browser time ($0.02/hour, billed per minute).
const API = 'https://api.browser-use.com/api/v4';
const HOST = 'api.browser-use.com';
const SESSION_MIN = 30; // minutes a cloud browser lives; a new one is started when it is about to run out
const IDLE_MS = Number(process.env.SW_BU_IDLE_MS) || 3 * 60 * 1000; // stop the browser after this long unused
const LOAD_WAIT_MS = Number(process.env.SW_BU_LOAD_WAIT_MS) || 90 * 1000; // page load + Cloudflare check
const CMD_MS = 60 * 1000;

// Minimal Chrome DevTools Protocol client over one WebSocket (flattened target sessions).
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch (_) { return; }
      const p = m.id && this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message || 'CDP error'}`));
      else p.resolve(m.result || {});
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Browser Use connection closed')); }
      this.pending.clear();
    });
  }

  static open(url, WS) {
    return new Promise((resolve, reject) => {
      const ws = new WS(url);
      const fail = () => reject(new Error('Could not connect to the Browser Use browser.'));
      ws.addEventListener('open', () => { ws.removeEventListener('error', fail); resolve(new Cdp(ws)); }, { once: true });
      ws.addEventListener('error', fail, { once: true });
    });
  }

  send(method, params = {}, sessionId, ms = CMD_MS) {
    if (this.closed) return Promise.reject(new Error('Browser Use connection closed'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, ms);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async eval(sessionId, expression, ms) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId, ms);
    if (r.exceptionDetails) throw new Error(`page script failed: ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`);
    return r.result ? r.result.value : undefined;
  }

  close() { try { this.ws.close(); } catch (_) {} }
}

// Browser Use's proxy country codes are ISO codes except the UK.
const proxyCountry = (cc) => (String(cc || '').toLowerCase() === 'gb' ? 'uk' : String(cc || '').toLowerCase()) || 'us';

class BrowserUse {
  constructor(throttle, getKey, { WebSocket: WS } = {}) {
    this.t = throttle;
    this.getKey = getKey;
    this.WS = WS || globalThis.WebSocket;
    this.browser = null; // {id, cdp, until, key, cc}
    this.idle = null;
  }

  get enabled() { return !!this.getKey(); }

  async _api(method, path, body, signal) {
    const key = this.getKey();
    if (!key) throw Object.assign(new Error('No Browser Use API key set (Settings).'), { fatal: true });
    let res;
    try {
      res = await http.fetchNow(`${API}${path}`, {
        method,
        headers: { 'X-Browser-Use-API-Key': key, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (e) {
      if (!(signal && signal.aborted)) log.warn(`Browser Use network error for ${path}: ${e.message}`);
      throw e;
    }
    const j = await res.json().catch(() => null);
    const fail = (msg, extra = {}) => { log.warn(`Browser Use ${res.status} for ${method} ${path}: ${msg}`); return Object.assign(new Error(msg), extra); };
    if (res.status === 401) throw fail('Browser Use rejected the API key (check Settings).', { fatal: true });
    if (res.status === 402) throw fail('Browser Use account is out of credits (or the key reached its spend limit).', { fatal: true });
    if (res.status === 429) { this.t.penalize(HOST, 30000); throw fail('Browser Use: too many browsers running at once, try again shortly.'); }
    if (!res.ok) {
      const d = j && j.detail;
      throw fail(`Browser Use error ${res.status}${d ? ': ' + (typeof d === 'string' ? d : d.message || JSON.stringify(d).slice(0, 200)) : ''}`, { status: res.status });
    }
    return j || {};
  }

  // webSocketDebuggerUrl for the cloud browser (cdpUrl is either that already, or the HTTP DevTools endpoint).
  async _wsUrl(cdpUrl, signal) {
    if (/^wss?:/i.test(cdpUrl)) return cdpUrl;
    const res = await http.fetchNow(`${cdpUrl.replace(/\/+$/, '')}/json/version`, { signal });
    const j = await res.json().catch(() => null);
    if (!j || !j.webSocketDebuggerUrl) throw new Error(`Browser Use browser did not answer (HTTP ${res.status}).`);
    return j.webSocketDebuggerUrl;
  }

  async _start(cc, signal) {
    let s;
    try {
      s = await this._api('POST', '/browsers', { proxyCountryCode: proxyCountry(cc), timeout: SESSION_MIN }, signal);
    } catch (e) {
      if (e.status !== 422) throw e;
      s = await this._api('POST', '/browsers', { timeout: SESSION_MIN }, signal); // country not offered as a proxy: use their default
    }
    if (!s.id || !s.cdpUrl) throw new Error('Browser Use did not return a browser.');
    log.info(`Browser Use browser started (${proxyCountry(cc)} proxy)`);
    let cdp;
    try {
      cdp = await Cdp.open(await this._wsUrl(s.cdpUrl, signal), this.WS);
    } catch (e) {
      this._stopRemote(s.id);
      throw e;
    }
    const until = s.timeoutAt ? Date.parse(s.timeoutAt) : Date.now() + SESSION_MIN * 60000;
    return { id: s.id, cdp, until: Number.isFinite(until) ? until : Date.now() + SESSION_MIN * 60000, key: this.getKey(), cc };
  }

  async _browserFor(cc, signal) {
    const b = this.browser;
    if (b && !b.cdp.closed && b.key === this.getKey() && b.cc === cc && b.until - Date.now() > 3 * 60000) return b;
    if (b) this.close();
    this.browser = await this._start(cc, signal);
    return this.browser;
  }

  _stopRemote(id) {
    this._api('PATCH', `/browsers/${id}`, { action: 'stop' }).catch(() => {});
  }

  /** Stop the cloud browser (idle, key changed, app quitting). Unused time is refunded by Browser Use. */
  close() {
    clearTimeout(this.idle);
    const b = this.browser;
    this.browser = null;
    if (!b) return;
    b.cdp.close();
    this._stopRemote(b.id);
    log.info('Browser Use browser stopped');
  }

  // Open a tab, load the page and wait until it is past Cloudflare. -> {cdp, sid, targetId}
  async _open(url, cc, signal) {
    const b = await this._browserFor(cc, signal);
    const { targetId } = await b.cdp.send('Target.createTarget', { url: 'about:blank' });
    const close = () => b.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    try {
      const { sessionId: sid } = await b.cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await b.cdp.send('Page.navigate', { url }, sid);
      const t0 = Date.now();
      for (;;) {
        if (signal && signal.aborted) throw new Error('cancelled');
        const st = await b.cdp.eval(sid, `({ href: location.href, ready: document.readyState, title: document.title, blocked: ${CHALLENGE_SCRIPT} })`).catch(() => null);
        const challenge = !!st && (st.blocked || CHALLENGE_TITLE.test(st.title || ''));
        if (st && st.href !== 'about:blank' && st.ready === 'complete' && !challenge) break;
        if (Date.now() - t0 > LOAD_WAIT_MS) throw new Error(challenge ? 'Browser Use could not get past SteamDB\'s Cloudflare check.' : 'SteamDB page did not load through Browser Use.');
        await sleep(1000);
      }
      return { cdp: b.cdp, sid, close };
    } catch (e) {
      close();
      throw e;
    }
  }

  // Same result shape as SteamDB.fetchApp.
  fetchApp(appid, cc, signal) {
    clearTimeout(this.idle);
    return this.t.run(HOST, 1500, async () => {
      let page;
      try {
        page = await this._open(`https://steamdb.info/app/${Number(appid)}/`, cc, signal);
        return readAppPage('Browser Use SteamDB', appid, await page.cdp.eval(page.sid, appPageScript(appid, cc)), log);
      } catch (e) {
        if (!e.fatal && !(signal && signal.aborted) && this.browser && this.browser.cdp.closed) this.close(); // dropped connection: start fresh next time
        throw e;
      } finally {
        if (page) page.close();
        clearTimeout(this.idle);
        this.idle = setTimeout(() => this.close(), IDLE_MS);
        if (this.idle.unref) this.idle.unref();
      }
    }, signal);
  }

  // Settings "Test" button: one game, proves the key works and SteamDB answers.
  async test(cc = 'us') {
    const r = await this.fetchApp(1672500, cc);
    const parts = [r.history ? `price graph ${r.history.length} points` : 'no price graph', r.gif ? 'preview video found' : 'no preview video'];
    return r.history || r.gif
      ? { ok: true, message: `Works: SteamDB loaded through Browser Use (${parts.join(', ')}).` }
      : { ok: false, message: 'Key accepted, but SteamDB returned nothing through Browser Use (see the log).' };
  }
}

module.exports = { BrowserUse, Cdp, proxyCountry };
