'use strict';
const { BrowserWindow } = require('electron');
const { sleep } = require('./throttle');
const { appPageScript, readAppPage, CHALLENGE_TITLE, CHALLENGE_SCRIPT } = require('./steamdb-parse');
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
    try { return await wc.executeJavaScript(CHALLENGE_SCRIPT); } catch (_) { return false; }
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

  // One app-page load per game, then SteamDB's own two XHR endpoints from inside that page (appPageScript).
  fetchApp(appid, cc, signal) {
    return this.t.run(HOST, GAP, async () => {
      const wc = await this._open(`https://${HOST}/app/${appid}/`, signal);
      return readAppPage('SteamDB', appid, await wc.executeJavaScript(appPageScript(appid, cc)), log);
    }, signal);
  }
}

module.exports = { SteamDB };
