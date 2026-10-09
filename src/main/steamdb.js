'use strict';
const { BrowserWindow } = require('electron');
const { sleep } = require('./throttle');
const { parseHistory, findGif, mediaUrls, CHALLENGE_TITLE } = require('./steamdb-parse');
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
      if (w.isDestroyed()) throw Object.assign(new Error('SteamDB check window was closed.'), { challenge: true });
      if (Date.now() - t0 > CHALLENGE_WAIT_MS) {
        w.hide();
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

  // One page load per game: price history (fetched from inside the page so cookies apply) + hover preview.
  fetchApp(appid, cc, signal) {
    return this.t.run(HOST, GAP, async () => {
      const wc = await this._open(`https://${HOST}/app/${appid}/`, signal);
      const page = await wc.executeJavaScript(`({ url: location.href, title: document.title, html: document.documentElement.outerHTML })`);
      const gif = findGif(page.html);
      let hist = null;
      let api = null;
      try {
        api = await wc.executeJavaScript(`fetch('/api/GetPriceHistory/?appid=${Number(appid)}&cc=${encodeURIComponent(cc)}', { credentials: 'include', headers: { 'x-requested-with': 'XMLHttpRequest' } }).then(async (r) => ({ status: r.status, type: r.headers.get('content-type'), body: await r.text() }))`);
        hist = parseHistory(JSON.parse(api.body));
      } catch (e) { log.warn(`SteamDB history for ${appid}: ${e.message}`); }
      log.info(`SteamDB ${appid}: history=${hist ? hist.history.length + ' points' : 'none'} gif=${gif ? 'yes' : 'no'}`);
      if (!hist || !gif) {
        // enough detail to see what SteamDB really returned without dumping the whole page
        log.info(`SteamDB ${appid} debug: ${JSON.stringify({
          page: { url: page.url, title: page.title, htmlLength: page.html.length },
          api: api ? { status: api.status, type: api.type, length: api.body.length, head: api.body.slice(0, 300) } : null,
          media: mediaUrls(page.html).slice(0, 8),
        })}`);
      }
      return { history: hist ? hist.history : null, low: hist ? hist.low : null, lowAt: hist ? hist.lowAt : null, gif };
    }, signal);
  }
}

module.exports = { SteamDB };
