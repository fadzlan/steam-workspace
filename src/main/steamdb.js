'use strict';
const { BrowserWindow } = require('electron');
const { sleep } = require('./throttle');
const { parseHistory, microtrailerUrl, CHALLENGE_TITLE } = require('./steamdb-parse');
const log = require('./log');

// steamdb.info sits behind Cloudflare, so plain HTTP gets a 403. Pages are loaded in a real
// Chromium window with a persistent session. When Cloudflare shows a check, that window is
// brought to the front so the user can solve it; once it clears the window hides again and the
// cookie is reused for later (still slow, still sparse) requests.
const PART = 'persist:steamdb';
const HOST = 'steamdb.info';
const GAP = 9000;
const CHALLENGE_WAIT_MS = Number(process.env.SW_CHALLENGE_WAIT_MS) || 3 * 60 * 1000;

class SteamDB {
  constructor(throttle) {
    this.t = throttle;
    this.win = null;
    this.onStatus = () => {}; // (message|null) => void, for UI hints
  }

  _window() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({ width: 560, height: 720, show: false, title: 'SteamDB check', autoHideMenuBar: true, webPreferences: { partition: PART, sandbox: true } });
    this.win.on('page-title-updated', (e) => e.preventDefault());
    return this.win;
  }

  async _blocked(wc) {
    if (CHALLENGE_TITLE.test(wc.getTitle())) return true;
    try { return await wc.executeJavaScript(`!!document.querySelector('#challenge-form, #challenge-running, .cf-turnstile, [name="cf-turnstile-response"]')`); } catch (_) { return false; }
  }

  // Load a URL; if Cloudflare intervenes, show the window and wait for the user to finish the check.
  async _open(url, signal) {
    const w = this._window();
    await w.loadURL(url).catch(() => {});
    let shown = false;
    const t0 = Date.now();
    while (await this._blocked(w.webContents)) {
      if (signal && signal.aborted) throw new Error('cancelled');
      if (!shown) {
        shown = true;
        log.info('SteamDB shows a Cloudflare check; asking the user to solve it');
        this.onStatus('SteamDB wants a human check. Solve it in the SteamDB window that just opened.');
        w.setTitle('SteamDB check: solve it, this window closes by itself');
        w.show(); w.focus();
      }
      if (w.isDestroyed()) { this.onStatus(null); throw Object.assign(new Error('SteamDB check window was closed.'), { challenge: true }); }
      if (Date.now() - t0 > CHALLENGE_WAIT_MS) {
        w.hide();
        this.onStatus(null);
        throw Object.assign(new Error('SteamDB check was not completed in time.'), { challenge: true });
      }
      await sleep(1000);
    }
    if (shown) { log.info('SteamDB check solved'); if (!w.isDestroyed()) w.hide(); }
    this.onStatus(null);
    return w.webContents;
  }

  // Open the window for the user to pass the check ahead of time (Settings button).
  showChallenge() {
    const w = this._window();
    w.setTitle('SteamDB check: solve it if shown, then close this window');
    w.show(); w.focus();
    w.loadURL(`https://${HOST}/`).catch(() => {});
  }

  // One app-page load per game, then SteamDB's own two XHR endpoints from inside that page (so the
  // Cloudflare cookie and referer apply): price history, and the hover card holding the micro-trailer.
  fetchApp(appid, cc, signal) {
    return this.t.run(HOST, GAP, async () => {
      const wc = await this._open(`https://${HOST}/app/${appid}/`, signal);
      const id = Number(appid);
      const r = await wc.executeJavaScript(`(async () => {
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
      })()`);
      let hist = null;
      try { hist = r.history ? parseHistory(JSON.parse(r.history.body)) : null; } catch (e) { log.warn(`SteamDB history for ${appid}: ${e.message}`); }
      const video = r.hover && r.hover.microtrailer ? microtrailerUrl(r.videoCdn, r.hover.microtrailer) : null;
      log.info(`SteamDB ${appid}: history=${hist ? hist.history.length + ' points' : 'none'}${r.history && r.history.more ? ' (truncated: 2-year history)' : ''} preview=${video ? 'yes' : 'no'}`);
      if (!hist || !video) {
        log.info(`SteamDB ${appid} debug: ${JSON.stringify({
          page: { url: r.url, title: r.title },
          history: r.history ? { status: r.history.status, length: r.history.body.length, head: r.history.body.slice(0, 300) } : r.historyErr,
          hover: r.hover ? { status: r.hover.status, length: r.hover.length, microtrailer: r.hover.microtrailer } : r.hoverErr,
        })}`);
      }
      return { history: hist ? hist.history : null, low: hist ? hist.low : null, lowAt: hist ? hist.lowAt : null, more: !!(r.history && r.history.more), gif: video };
    }, signal);
  }
}

module.exports = { SteamDB };
