// Durable JSON store for money files (data/credits.json, data/credit-accounts.json).
//
// A credit is a payment that already happened on chain; the file is the only record that it has not been spent.
// Writing it in place means a process killed mid-write leaves truncated JSON, and a loader that answers {} on a
// parse error turns every unspent balance into zero without saying anything. Both are fixed here:
//   - writeJsonAtomic writes a temp file in the same directory, fsyncs it, keeps the previous file as .bak, then
//     renames over the destination. A reader sees the old file or the new one, never a partial one.
//   - readJsonStore tells the caller whether a file was missing (fresh install), damaged (partial JSON), or
//     recovered from .bak, so "no credits" is never inferred from a damaged file.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function writeJsonAtomic(file, value, opts = {}) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');
  const body = JSON.stringify(value);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (opts.afterWrite) opts.afterWrite();   // test seam: simulate a crash before the rename
    // Keep the previous complete file as .bak before it is replaced. A rename over the destination is atomic on the
    // same filesystem, so a reader never observes a half-written ledger.
    try { fs.copyFileSync(file, file + '.bak'); } catch { /* first write: nothing to keep yet */ }
    fs.renameSync(tmp, file);
    // On the first write there was no previous file to keep, so the .bak is made from the copy just written: a ledger
    // that has been written once must already be recoverable from a crash, not only from its second write onwards.
    try { fs.accessSync(file + '.bak'); } catch { try { fs.copyFileSync(file, file + '.bak'); } catch { /* best effort */ } }
    try { const d = fs.openSync(dir, 'r'); fs.fsyncSync(d); fs.closeSync(d); } catch { /* directory fsync is best effort */ }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch { /* renamed already, or never created */ }
  }
}

function readJsonStore(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { value: {}, damaged: false, recovered: false };
    return { value: {}, damaged: true, recovered: false, error: e.message };
  }
  if (!raw.trim()) return { value: {}, damaged: true, recovered: false, error: 'empty file' };
  try { return { value: JSON.parse(raw), damaged: false, recovered: false }; }
  catch (e) {
    // A damaged ledger must not be read as "no credits". Fall back to the last complete copy and say so.
    try {
      const bak = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
      return { value: bak, damaged: true, recovered: true, error: e.message };
    } catch { return { value: {}, damaged: true, recovered: false, error: e.message }; }
  }
}

module.exports = { writeJsonAtomic, readJsonStore };
