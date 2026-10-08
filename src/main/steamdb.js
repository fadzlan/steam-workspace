'use strict';
const { BrowserWindow } = require('electron');
const { sleep } = require('./throttle');

// steamdb.info sits behind Cloudflare, so plain HTTP gets a 403. We load pages in a
// real (hidden) Chromium window with a persistent session instead. If Cloudflare shows
// a challenge, `showChallenge()` opens the window so the user can solve it once; the
// cookie then persists for later (still slow, still sparse) requests.
const PART = 'persist:steamdb';
const HOST = 'steamdb.info';
const GAP = 9000;

class SteamDB {
  constructor(throttle) {
    this.t = throttle;
    this.win = null;
  }

  _window(show = false) {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({ width: 900, height: 700, show, title: 'SteamDB – solve the check if shown', webPreferences: { partition: PART, sandbox: true } });
    return this.win;
  }

  async _load(url, signal) {
    return this.t.run(HOST, GAP, async () => {
      const w = this._window();
      await w.loadURL(url).catch(() => {});
      for (let i = 0; i < 20; i++) {
        const title = w.webContents.getTitle();
        if (!/just a moment|attention required/i.test(title)) break;
        if (i === 19) throw Object.assign(new Error('SteamDB is showing a Cloudflare check.'), { challenge: true });
        await sleep(1000);
      }
      return w.webContents;
    }, signal);
  }

  showChallenge() {
    const w = this._window(true);
    w.show();
    w.loadURL(`https://${HOST}/`).catch(() => {});
  }

  // Price history for a store app. Returns {history:[[ms, cents]], low, lowAt} or null.
  async priceHistory(appid, cc, signal) {
    const wc = await this._load(`https://${HOST}/api/GetPriceHistory/?appid=${appid}&cc=${cc}`, signal);
    const txt = await wc.executeJavaScript('document.body.innerText');
    let j;
    try { j = JSON.parse(txt); } catch (_) { return null; }
    const d = (j && j.data) || {};
    const raw = d.final || d.history || (Array.isArray(d) ? d : null);
    if (!Array.isArray(raw) || !raw.length) return null;
    const history = raw.map((p) => [Number(p[0]), Math.round(Number(p[1]) * (d.final ? 100 : 1))]).filter((p) => p[0] && p[1] >= 0);
    let low = history[0];
    for (const p of history) if (p[1] < low[1]) low = p;
    return { history, low: low[1], lowAt: low[0] };
  }

  // The animated hover preview shown on SteamDB lists; best-effort page scrape.
  async hoverGif(appid, signal) {
    const wc = await this._load(`https://${HOST}/app/${appid}/`, signal);
    const html = await wc.executeJavaScript('document.documentElement.outerHTML');
    const urls = [...html.matchAll(/https?:\/\/[^"'\s)]+\.(?:gif|webp)(?:\?[^"'\s)]*)?/gi)].map((m) => m[0]);
    return urls.find((u) => /hover|animated/i.test(u)) || urls[0] || null;
  }
}

module.exports = { SteamDB };
