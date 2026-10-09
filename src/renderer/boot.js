'use strict';
(async () => {
  catBtns($('#bcats'), S.bcats, () => SW.charts.bub());
  catBtns($('#pcats'), S.pcats, () => SW.charts.pd());
  seg('#bscope', 'scope', () => SW.charts.bub());
  seg('#bsrc', 'bsrc', () => SW.charts.bub());
  seg('#psrc', 'psrc', () => SW.charts.pd());
  seg('#csrc', 'csrc', () => SW.charts.cov());
  $('#topn').oninput = (e) => { S.topn = +e.target.value; $('#topv').textContent = S.topn; SW.charts.bub(); };
  $('#pn').oninput = (e) => { S.pn = +e.target.value; $('#pnv').textContent = S.pn; SW.charts.pd(); };
  $('#cn').oninput = (e) => { S.cn = +e.target.value; $('#cnv').textContent = S.cn; deb(() => SW.charts.cov()); };
  $('#csale').onchange = (e) => { S.csale = e.target.checked; SW.charts.cov(); };
  let busy = false, again = false;
  const reload = async () => {
    if (busy) { again = true; return; }
    busy = true;
    try { await loadState(); renderChrome(); renderTab(); } catch (e) { console.error(e && e.stack || e); }
    busy = false;
    if (again) { again = false; reload(); }
  };
  api.onState(reload);
  api.onProgress(onProgress);
  api.onHint((m) => { $('#hint').hidden = !m; $('#hint').textContent = m || ''; });
  await reload();
  const h = location.hash.slice(1);
  show(['list', 'mine', 'bub', 'pd', 'cov'].includes(h) ? h : 'list');
})();
