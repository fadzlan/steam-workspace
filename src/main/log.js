'use strict';
const fs = require('fs');
const path = require('path');

// Small rotating file log (app.log, rolled to app.old.log at 1 MB). Secrets are scrubbed.
let file = null;
const MAX = 1024 * 1024;

const redact = (s) => String(s)
  .replace(/([?&](?:key|access_token|token)=)[^&\s"']+/gi, '$1***')
  .replace(/("(?:familyToken|apiKey)"\s*:\s*")[^"]*/g, '$1***');

function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'app.log');
    if (fs.existsSync(file) && fs.statSync(file).size > MAX) fs.renameSync(file, path.join(dir, 'app.old.log'));
  } catch (_) { file = null; }
}

function write(level, ...parts) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${redact(parts.map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'object' ? JSON.stringify(p) : p)).join(' '))}\n`;
  if (process.env.SW_LOG_STDERR) process.stderr.write(line);
  if (!file) return;
  try { fs.appendFileSync(file, line); } catch (_) {}
}

module.exports = {
  init, redact,
  info: (...a) => write('INFO', ...a),
  warn: (...a) => write('WARN', ...a),
  error: (...a) => write('ERROR', ...a),
  dir: () => (file ? path.dirname(file) : null),
};
