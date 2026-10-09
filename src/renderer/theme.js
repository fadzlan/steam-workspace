'use strict';
// Applied before first paint so the chosen theme does not flash. 'system' = follow the OS.
(function () {
  var t = 'system';
  try { t = localStorage.getItem('sw-theme') || 'system'; } catch (e) {}
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
})();
