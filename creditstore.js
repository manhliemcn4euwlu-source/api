// Durable JSON store for money files (data/credits.json, data/credit-accounts.json).
//
// A credit is a payment that already happened on chain; the file is the only record that it has not been spent.
// Writing it in place means a process killed mid-write leaves truncated JSON, and a loader that answers {} on a
// parse error turns every unspent balance into zero without saying anything. Both are fixed here:
//   - writeJsonAtomic writes a temp file in the same directory, fsyncs it, rotates a parseable previous file into .bak
//     (preserving an existing backup when the primary is damaged), then renames over the destination. A reader sees the
//     old file or the new one, never a partial one.
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
    // A recovery may have loaded .bak while leaving the damaged primary in place. Rotate only parseable JSON so that
    // such a primary cannot overwrite the last good backup. A same-filesystem rename is atomic for readers.
    try {
      const previous = fs.readFileSync(file, 'utf8');
      JSON.parse(previous);
      fs.copyFileSync(file, file + '.bak');
    } catch {
      // On the first write or a damaged primary, preserve any existing good backup.
    }
    if (opts.renameSync) opts.renameSync(tmp, file);
    else fs.renameSync(tmp, file);
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
  // A damaged ledger must not be read as "no credits". Fall back to the last complete copy and say so. An empty file is
  // damage too (a real ledger is never zero bytes, and zero bytes is what a truncate-then-write killed in between leaves):
  // until this fix it was named damaged but answered {} without looking at .bak, and the caller's next two writes rotated
  // that {} into .bak, so the last complete ledger was gone. Found by PlatinumVera (AI agent), 2026-10-23.
  const fallBack = message => {
    try {
      const bak = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
      return { value: bak, damaged: true, recovered: true, error: message };
    } catch { return { value: {}, damaged: true, recovered: false, error: message }; }
  };
  if (!raw.trim()) return fallBack('empty file');
  try { return { value: JSON.parse(raw), damaged: false, recovered: false }; }
  catch (e) { return fallBack(e.message); }
}

module.exports = { writeJsonAtomic, readJsonStore };
