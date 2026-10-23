// Require this before ../server in any test that boots the server. npm test runs in the directory the service runs
// from, so the live ledger and counters are on disk under data/. Every write under data/ is dropped here: writeFileSync
// and appendFileSync, and the atomic store's path too (openSync of the temp file, renameSync over the destination,
// copyFileSync to .bak, unlinkSync of the temp), since guarding writeFileSync alone let an fd write through
// (7c92f1f, found by umpireboulianne-design on PR #102; and again on 2026-10-23 when data/checks.json moved to the atomic
// store and the free-limit test, guarded for writeFileSync only, wrote 61 verify counts into a copy of the live file).
// Reads are untouched. restore() puts the real functions back; the stubs are per process, which node --test gives
// each file.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const DATA_DIR = path.join(__dirname, '..', 'data') + path.sep;
const inData = (p) => String(p).startsWith(DATA_DIR);
const real = { writeFileSync: fs.writeFileSync, appendFileSync: fs.appendFileSync, openSync: fs.openSync, renameSync: fs.renameSync, copyFileSync: fs.copyFileSync, unlinkSync: fs.unlinkSync };
const SCRATCH = path.join(os.tmpdir(), 'api-test-scratch-' + process.pid);
fs.writeFileSync = (p, ...a) => { if (inData(p)) return; return real.writeFileSync(p, ...a); };
fs.appendFileSync = (p, ...a) => { if (inData(p)) return; return real.appendFileSync(p, ...a); };
fs.openSync = (p, ...a) => (inData(p) ? real.openSync(SCRATCH, 'w') : real.openSync(p, ...a));
fs.renameSync = (p, ...a) => { if (inData(p)) return; return real.renameSync(p, ...a); };
fs.copyFileSync = (p, ...a) => { if (inData(p)) return; return real.copyFileSync(p, ...a); };
fs.unlinkSync = (p) => { if (inData(p)) return; return real.unlinkSync(p); };
function restore() { Object.assign(fs, real); try { real.unlinkSync(SCRATCH); } catch {} }
module.exports = { DATA_DIR, inData, real, SCRATCH, restore };
