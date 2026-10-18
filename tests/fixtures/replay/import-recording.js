'use strict';

// +================================================================+
// |  Recording -> replay fixture                                   |
// |                                                                |
// |  Turns a recording made with CODE_CRUMB_RECORD (lib/recorder)  |
// |  into a fixture for tests/test-replay.js:                      |
// |                                                                |
// |    node tests/fixtures/replay/import-recording.js \            |
// |      ~/.code-crumb-record/2026-10-18.jsonl my-bug \            |
// |      [--session <id>] [--from N] [--to M] [--note "..."]       |
// |      [--force]                                                 |
// |                                                                |
// |  writes tests/fixtures/replay/my-bug.jsonl; then               |
// |    CRUMB_UPDATE_GOLDEN=1 node tests/run.js replay              |
// |  writes its golden. Review both before committing.             |
// |                                                                |
// |  Shape-mode pseudonyms are renumbered in order of first        |
// |  appearance (s1, a1, t1...); a full-mode recording is          |
// |  anonymised here exactly as shape mode would have done, so no  |
// |  raw payload reaches a fixture. Times become relative to the   |
// |  first record. --session keeps the records naming that         |
// |  session (raw id or pseudonym), plus those naming none.        |
// |  --from/--to count records, 1-based, headers excluded.         |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { anonymise, mapIds, shapeArgv, freeText } = require('../../../lib/recorder');

// -- Reading -------------------------------------------------------------

// Records in file order, headers apart. A malformed line (a recording cut
// off mid-write) is skipped, not fatal.
function parseRecording(text) {
  const headers = [];
  const records = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    if (rec.kind === 'header') headers.push(rec);
    else records.push(rec);
  }
  return { headers, records };
}

// -- Renumbering -----------------------------------------------------------

// Pseudonyms in order of first appearance, per kind: s1, s2, a1, t1... An id
// already a shape-mode pseudonym (`s-0a1b2c3d4e5f`) is keyed by its hash,
// which the recorder computes regardless of the kind, so one id seen under
// two keys (a codex thread_id and the hooks' session_id) stays one.
function sequentialIds() {
  const byKey = new Map();
  const counters = Object.create(null);
  return (kind, id) => {
    const m = /^[a-z]-([0-9a-f]{12})$/.exec(id);
    const key = m ? m[1] : id;
    let out = byKey.get(key);
    if (!out) {
      counters[kind] = (counters[kind] || 0) + 1;
      out = `${kind}${counters[kind]}`;
      byKey.set(key, out);
    }
    return out;
  };
}

// The session ids a record's payload names (raw or pseudonymised).
function sessionIdsOf(rec) {
  const ids = new Set();
  mapIds(rec.payload, (kind, id) => { if (kind === 's') ids.add(id); return id; });
  return ids;
}

const TOKEN_RE = /^[A-Za-z0-9_.:@+-]{1,64}$/;

// -- Fixture -----------------------------------------------------------

// The fixture text for one recording. opts: { session, from, to, note }.
function toFixture(text, opts = {}) {
  const { headers, records } = parseRecording(text);
  const from = Math.max(1, opts.from || 1);
  const to = opts.to || records.length;
  let picked = records.slice(from - 1, to);
  if (opts.session) {
    picked = picked.filter(rec => {
      const ids = sessionIdsOf(rec);
      return ids.size === 0 || ids.has(opts.session);
    });
  }
  const ids = sequentialIds();
  const t0 = picked.length && typeof picked[0].at === 'number' ? picked[0].at : 0;
  const lines = [];
  const meta = headers[0] || {};
  lines.push({
    v: 1, kind: 'header', synthetic: false,
    note: opts.note || 'imported from a recording',
    recorded: { mode: meta.mode || '', platform: meta.platform || '', node: meta.node || '', codeCrumb: meta.codeCrumb || '' },
  });
  for (const rec of picked) {
    const full = rec.mode === 'full';
    const out = {
      v: 1,
      at: typeof rec.at === 'number' ? Math.max(0, rec.at - t0) : 0,
      source: TOKEN_RE.test(rec.source || '') ? rec.source : 'unknown',
      editor: TOKEN_RE.test(rec.editor || '') ? rec.editor : '',
      event: TOKEN_RE.test(rec.event || '') ? rec.event : '',
      mode: 'shape',
    };
    if (Array.isArray(rec.argv)) out.argv = full ? shapeArgv(rec.argv) : rec.argv;
    if (rec.truncated) { out.truncated = true; out.over = rec.over; }
    if (rec.unparsed) out.unparsed = true;
    if (rec.unparsed) {
      out.payload = full && typeof rec.payload === 'string' ? freeText(rec.payload) : rec.payload;
    } else if (full) {
      out.payload = anonymise(rec.payload, { pseudonym: ids });
    } else {
      out.payload = mapIds(rec.payload, ids);
    }
    lines.push(out);
  }
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

// -- CLI -------------------------------------------------------------------

function main(argv) {
  const pos = [];
  const opts = {};
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session') opts.session = argv[++i];
    else if (a === '--from') opts.from = parseInt(argv[++i], 10);
    else if (a === '--to') opts.to = parseInt(argv[++i], 10);
    else if (a === '--note') opts.note = argv[++i];
    else if (a === '--force') force = true;
    else pos.push(a);
  }
  if (pos.length !== 2 || !/^[A-Za-z0-9_-]{1,64}$/.test(pos[1])) {
    console.error('Usage: node tests/fixtures/replay/import-recording.js <recording.jsonl> <fixture-name>');
    console.error('         [--session <id>] [--from N] [--to M] [--note "..."] [--force]');
    process.exit(1);
  }
  const out = path.join(__dirname, `${pos[1]}.jsonl`);
  if (fs.existsSync(out) && !force) {
    console.error(`${path.relative(process.cwd(), out)} exists; --force replaces it`);
    process.exit(1);
  }
  const text = toFixture(fs.readFileSync(pos[0], 'utf8'), opts);
  fs.writeFileSync(out, text, 'utf8');
  console.log(`wrote ${path.relative(process.cwd(), out)} (${text.split('\n').length - 2} records)`);
  console.log('next: CRUMB_UPDATE_GOLDEN=1 node tests/run.js replay, then review both files');
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { parseRecording, sequentialIds, toFixture };
