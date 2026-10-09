'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = async (ch, ...a) => {
  const r = await ipcRenderer.invoke(ch, ...a);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld('api', {
  state: () => call('state'),
  setSettings: (p) => call('settings', p),
  sync: (mode) => call('sync', mode),
  cancel: () => call('cancel'),
  listAdd: (id) => call('list:add', id),
  listRemove: (id) => call('list:remove', id),
  listSet: (id, p) => call('list:set', id, p),
  setWhys: (a) => call('whys', a),
  steamdbFetch: (id) => call('steamdb:fetch', id),
  steamdbCheck: () => call('steamdb:check'),
  steamLogin: () => call('steam:login'),
  steamLogout: () => call('steam:logout'),
  openLogs: () => call('log:open'),
  cacheInfo: () => call('cache:info'),
  cacheClear: () => call('cache:clear'),
  open: (url) => call('open', url),
  onState: (fn) => ipcRenderer.on('state', () => fn()),
  onProgress: (fn) => ipcRenderer.on('progress', (_e, s) => fn(s)),
});
