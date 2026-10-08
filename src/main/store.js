'use strict';
const fs = require('fs');
const path = require('path');

// Tiny JSON file store with debounced, atomic writes.
class JsonFile {
  constructor(file, fallback) {
    this.file = file;
    this.data = fallback;
    this.timer = null;
    try {
      this.data = { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (_) {}
  }

  save(now = false) {
    clearTimeout(this.timer);
    const write = () => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data));
        fs.renameSync(tmp, this.file);
      } catch (e) {
        console.error('save failed', this.file, e);
      }
    };
    if (now) write();
    else this.timer = setTimeout(write, 400);
  }
}

module.exports = { JsonFile };
