'use strict';
// HTTP Range handling for the cache protocol: <video> needs 206 + Content-Range to play and loop larger files.
// -> {status, headers, body}
function serveBuffer(buf, type, rangeHeader) {
  const total = buf.length;
  const base = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'max-age=31536000' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '');
  if (!m || (m[1] === '' && m[2] === '')) return { status: 200, headers: { ...base, 'content-length': String(total) }, body: buf };
  const start = m[1] === '' ? Math.max(0, total - Number(m[2])) : Number(m[1]);
  const end = m[1] === '' || m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
  if (start >= total || end < start) return { status: 416, headers: { 'content-range': `bytes */${total}` }, body: '' };
  return { status: 206, headers: { ...base, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': String(end - start + 1) }, body: buf.subarray(start, end + 1) };
}

module.exports = { serveBuffer };
