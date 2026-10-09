'use strict';
const { app, BrowserWindow, ipcMain, protocol, shell, session, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Throttle } = require('./throttle');
const { setFetch } = require('./http');
const { Steam } = require('./steam');
const { SteamDB } = require('./steamdb');
const { Engine } = require('./engine');
const { Images, EXT_MIME } = require('./images');
const log = require('./log');

protocol.registerSchemesAsPrivileged([{ scheme: 'swimg', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

if (process.env.SW_USERDATA) app.setPath('userData', process.env.SW_USERDATA);

if (process.env.SW_SHOT) app.disableHardwareAcceleration();

let win, engine, images;

function createEngine() {
  const dir = path.join(app.getPath('userData'), 'cache');
  log.init(path.join(app.getPath('userData'), 'logs'));
  log.info(`Steam Workspace ${app.getVersion()} electron=${process.versions.electron} ${process.platform} ${process.arch}`);
  const throttle = new Throttle(() => (engine ? engine.settings.slowness : 1));
  engine = new Engine({ dir, steam: new Steam(throttle), steamdb: new SteamDB(throttle), emit: (k) => send(k) });
  engine.steamdb.onStatus = (m) => win && !win.isDestroyed() && win.webContents.send('hint', m);
  images = new Images(path.join(dir, 'images'), throttle, (id) => engine.hoverUrl(id), (id) => engine.assetUrls(id));
}

let pushTimer = null;
function send(kind) {
  if (!win || win.isDestroyed()) return;
  if (kind === 'progress') return win.webContents.send('progress', engine.status);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => win && !win.isDestroyed() && win.webContents.send('state'), 120);
}

// swimg://thumb/123  ->  cached (or lazily, slowly downloaded) image; swimg://hover/123 -> preview video.
// Served through net.fetch(file://) so <video> gets Range support.
function registerImageProtocol() {
  protocol.handle('swimg', async (req) => {
    const u = new URL(req.url);
    const file = await images.get(u.hostname, u.pathname.slice(1));
    if (!file) return new Response('', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString(), { headers: req.headers });
    const headers = new Headers(res.headers);
    headers.set('content-type', EXT_MIME[path.extname(file)] || 'application/octet-stream');
    headers.set('cache-control', 'max-age=31536000');
    return new Response(res.body, { status: res.status, headers });
  });
}

// Sign in to Steam in a normal browser window so we can read the family library with the
// user's own session. Credentials never touch this app; we only read a short-lived web token.
async function steamLogin() {
  const ses = session.fromPartition('persist:steamlogin');
  const w = new BrowserWindow({ width: 520, height: 760, title: 'Sign in to Steam, then close this window', webPreferences: { session: ses, sandbox: true }, parent: win });
  w.setMenuBarVisibility(false);
  w.loadURL('https://store.steampowered.com/login/?redir=pointssummary');
  await new Promise((r) => w.on('closed', r));
  const res = await ses.fetch('https://store.steampowered.com/pointssummary/ajaxgetasyncconfig');
  const j = await res.json().catch(() => null);
  const token = j && j.data && j.data.webapi_token;
  if (!token) throw new Error('Not signed in to Steam.');
  engine.setSettings({ familyToken: token, familyTokenAt: Date.now() });
  return true;
}

function wrap(fn) {
  return async (_e, ...a) => {
    try { return { ok: true, value: await fn(...a) }; } catch (e) { return { ok: false, error: e.message }; }
  };
}

function registerIpc() {
  ipcMain.handle('state', wrap(() => engine.getState()));
  ipcMain.handle('settings', wrap((p) => engine.setSettings(p)));
  ipcMain.handle('sync', wrap((mode) => engine.sync(mode)));
  ipcMain.handle('cancel', wrap(() => engine.cancel()));
  ipcMain.handle('list:add', wrap((id) => engine.listAdd(id)));
  ipcMain.handle('list:remove', wrap((id) => engine.listRemove(id)));
  ipcMain.handle('list:set', wrap((id, p) => engine.listSet(id, p)));
  ipcMain.handle('whys', wrap((arr) => engine.setWhys(arr)));
  ipcMain.handle('steamdb:fetch', wrap((id) => engine.fetchSteamDb(id)));
  ipcMain.handle('steamdb:check', wrap(() => engine.steamdb.showChallenge()));
  ipcMain.handle('steam:login', wrap(steamLogin));
  ipcMain.handle('steam:logout', wrap(async () => {
    await session.fromPartition('persist:steamlogin').clearStorageData();
    engine.setSettings({ familyToken: null, familyTokenAt: 0 });
  }));
  ipcMain.handle('log:open', wrap(async () => { const d = log.dir(); if (!d) throw new Error('Log not available'); await shell.openPath(d); return d; }));
  ipcMain.handle('cache:info', wrap(() => images.size()));
  ipcMain.handle('cache:clear', wrap(() => { images.clear(); }));
  ipcMain.handle('open', wrap((url) => {
    if (!/^https:\/\/(store\.steampowered\.com|steamdb\.info|steamcommunity\.com)\//.test(url)) throw new Error('blocked');
    return shell.openExternal(url);
  }));
}

process.on('uncaughtException', (e) => log.error('uncaughtException', e));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));

app.whenReady().then(() => {
  setFetch((u, o) => net.fetch(u, o));
  createEngine();
  registerImageProtocol();
  registerIpc();
  win = new BrowserWindow({
    width: 1500, height: 940, backgroundColor: '#14181f', title: 'Steam Workspace', icon: path.join(__dirname, '..', '..', 'resources', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (e, lvl, msg) => {
    const lv = typeof e.level === 'string' ? { debug: 0, info: 1, warning: 2, error: 3 }[e.level] : lvl;
    if (lv >= 2) log.warn('renderer:', e.message || msg);
  });
  win.webContents.on('render-process-gone', (_e, d) => log.error('render-process-gone', d));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url).catch(() => {}); return { action: 'deny' }; });
  win.loadURL(pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href + (process.env.SW_HASH ? '#' + process.env.SW_HASH : ''));
  if (process.env.SW_SHOT) win.webContents.once('did-finish-load', () => setTimeout(async () => {
    if (process.env.SW_EVAL) { await win.webContents.executeJavaScript(process.env.SW_EVAL); await new Promise((r) => setTimeout(r, 800)); }
    const img = await win.webContents.capturePage();
    fs.writeFileSync(process.env.SW_SHOT, img.toPNG());
    app.quit();
  }, 3500));
});

app.on('window-all-closed', () => app.quit());
