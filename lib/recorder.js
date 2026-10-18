'use strict';

// +================================================================+
// |  Payload Recorder -- what the editors really send, on disk     |
// |                                                                |
// |  Off unless CODE_CRUMB_RECORD is set. Then every payload a     |
// |  hook or adapter receives is appended as one JSON line to      |
// |  ~/.code-crumb-record/<YYYY-MM-DD>.jsonl (or the file named    |
// |  by CODE_CRUMB_RECORD_FILE):                                   |
// |    { v: 1, at, source, editor, event, mode, argv?, payload }   |
// |                                                                |
// |  CODE_CRUMB_RECORD=1 (or shape): anonymised -- ids become      |
// |  stable pseudonyms, text becomes a placeholder, commands and   |
// |  paths keep their structure. CODE_CRUMB_RECORD=full: the raw   |
// |  payload, prompts, paths and secrets included, for local       |
// |  debugging only.                                               |
// |                                                                |
// |  A recording replays through tests/test-replay.js once         |
// |  tests/fixtures/replay/import-recording.js has turned it into  |
// |  a fixture. The hook points call record() only after their     |
// |  own `process.env.CODE_CRUMB_RECORD` check, so the disabled    |
// |  path never loads this file.                                   |
// +================================================================+

const fs = require('fs');
const path = require('path');

// -- Settings ----------------------------------------------------------

const RECORD_VERSION = 1;
// A day's recording stops growing here: this is a debugging log, and a
// forgotten CODE_CRUMB_RECORD must not fill the disk.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// One record larger than this is replaced by a marker. A shape-mode record
// can outgrow its payload (every short string becomes a placeholder).
const MAX_LINE_CHARS = 2 * 1024 * 1024;
// update-state.js and processStdinEvent stop reading stdin here; a payload
// that size is recorded as a marker of its ids, never its body.
const MAX_INPUT = 1048576;
// Containers nested deeper are emptied. Nothing that classifies a payload
// reads past depth 4, and the cap also keeps a hostile payload from
// overflowing the stack.
const MAX_DEPTH = 32;
// What `full` mode keeps of a payload that is not JSON at all.
const MAX_UNPARSED_CHARS = 65536;
// The secret behind shape mode's pseudonyms, one per recording directory.
// It never leaves the machine: a recording shared without it cannot be
// matched back to real session ids.
const KEY_FILE = '.code-crumb-record.key';

// -- Mode and location ---------------------------------------------------

// '' (off), 'shape' or 'full'. Any other value records in shape mode: an
// unrecognised setting must fail safe, never raw.
function recordMode(env = process.env) {
  const v = String(env.CODE_CRUMB_RECORD || '').trim().toLowerCase();
  if (!v || v === '0' || v === 'off' || v === 'false' || v === 'no') return '';
  return v === 'full' ? 'full' : 'shape';
}

// The local calendar day, as state-machine's localDay counts "today".
function localDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Same HOME rule as shared.js, read at call time so a test can point it.
function homeDir(env) {
  return env.USERPROFILE || env.HOME || '/tmp';
}

// CODE_CRUMB_RECORD_FILE wins; a relative one is taken from HOME, never from
// the hook's cwd (that is the user's project, different for every window).
function recordFile(env = process.env, now = Date.now()) {
  const home = homeDir(env);
  const override = String(env.CODE_CRUMB_RECORD_FILE || '').trim();
  if (override) return path.resolve(home, override);
  return path.join(home, '.code-crumb-record', `${localDay(now)}.jsonl`);
}

// -- Pseudonyms ------------------------------------------------------------

// The directory's key, created on first use (the one time the recorder loads
// crypto). link() publishes a complete file atomically and fails if one
// exists, so two hooks starting together agree on one key. '' when it cannot
// be had: ids are then hashed unkeyed, still stable, merely guessable for a
// low-entropy id like `claude-1234`.
function readKey(dir) {
  const keyPath = path.join(dir, KEY_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const k = fs.readFileSync(keyPath, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(k)) return k;
    } catch {}
    const key = require('crypto').randomBytes(32).toString('hex');
    const tmp = `${keyPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, key, { mode: 0o600 });
      fs.linkSync(tmp, keyPath);
      return key;
    } catch {
      // EEXIST: another hook won -- read its key. Anything else (a file
      // system without hard links): the plain exclusive create.
      try { fs.writeFileSync(keyPath, key, { flag: 'wx', mode: 0o600 }); return key; } catch {}
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
  return '';
}

// A keyed 53-bit hash of `key:id` (bryc's cyrb53, public domain), not an
// HMAC: require('crypto') alone costs a fresh hook process 15-20 ms, longer
// than the rest of the recorder. The ids it hides are random already (uuids,
// `toolu_` ids); the key -- in effect 64 bits of hash state, never shared --
// is what stops a pseudonym being recomputed from a guessed id such as
// `claude-1234`. Not a MAC against a determined attacker. Linear.
function keyedHash(key, id) {
  const str = `${key}:${id}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0').slice(-12);
}

// kind + '-' + 12 hex of keyedHash(key, id). The hash ignores the kind, so
// one id under two different keys (a codex thread_id and the hooks'
// session_id) keeps one hash; the prefix only says what the id named.
function makePseudonymiser(key) {
  const cache = new Map();
  return (kind, id) => {
    let h = cache.get(id);
    if (h === undefined) {
      h = keyedHash(key || 'code-crumb', id);
      cache.set(id, h);
    }
    return `${kind}-${h}`;
  };
}

// -- What survives shape mode ---------------------------------------------

// Keys whose string values are ids: replaced by a pseudonym that keeps
// equality. The letter is the pseudonym's prefix: s session, a agent,
// t tool call, u turn, p plugin process, i any other id.
const ID_KINDS = Object.assign(Object.create(null), {
  session_id: 's', sessionId: 's', sessionID: 's', thread_id: 's', 'thread-id': 's',
  parentSession: 's', parentID: 's', parent_session_id: 's', conversation_id: 's',
  agent_id: 'a', agentId: 'a', agentID: 'a', subagent_id: 'a',
  tool_use_id: 't', toolUseId: 't', callID: 't', call_id: 't', tool_call_id: 't', toolCallId: 't',
  turn_id: 'u', turnId: 'u', 'turn-id': 'u',
  pluginId: 'p',
  id: 'i', item_id: 'i', messageID: 'i', partID: 'i', requestID: 'i', permissionID: 'i',
  backgroundTaskId: 'i', task_id: 'i', taskId: 'i',
});

// Keys whose values are a closed vocabulary -- event names, sources,
// reasons, modes, statuses, error kinds -- kept verbatim while they look
// like one (TOKEN_RE: one short token, no spaces, no path separators). Free
// text under one of these names (an MCP tool's `type: "a sentence"`) fails
// the test and becomes a placeholder like any other text. Numbers under them
// are kept whatever their size: an exit code may be -1073741819.
const ENUM_KEYS = new Set([
  'hook_event_name', 'notification_type', 'source', 'reason', 'trigger',
  'agent_type', 'subagent_type', 'permission_mode', 'type', 'status', 'phase',
  'event', 'kind', 'errorName', 'error_type', 'error', 'action', 'response',
  'decision', 'behavior', 'permissionDecision', 'stop_reason', 'level', 'severity',
  'role', 'mode', 'output_mode', 'effort', 'matcher', 'model_name', 'editor',
  'exit', 'exitCode', 'exit_code', 'seq', 'endSeq', 'signal',
]);
const TOKEN_RE = /^[A-Za-z0-9_.:@+-]{1,64}$/;
// Model ids may carry a vendor path: `openai/gpt-5`.
const MODEL_KEYS = new Set(['model', 'to_model', 'from_model', 'modelID', 'modelId', 'resolvedModel']);
const MODEL_RE = /^[A-Za-z0-9_.:@+\-/[\]]{1,128}$/;
// `name` is an SDK error's class (OpenCode's session.error) -- or, inside a
// tool's input, anything at all, a person's name included.
const ERROR_NAME_RE = /^[A-Za-z]{0,60}(?:Error|Exception)$/;
// Tool and server names: built-in names survive the shape rule whole (their
// words are in VOCAB); an MCP server's or a custom tool's own words do not.
const TOOL_KEYS = new Set(['tool_name', 'tool', 'toolName', 'server', 'mcp_server_name']);

// Keys whose values are shell commands or paths: the shape rule (shapeText)
// keeps their structure and drops their words.
const SHAPE_KEYS = new Set([
  'command', 'cmd', 'file_path', 'filePath', 'path', 'paths', 'notebook_path',
  'cwd', 'workdir', 'dir', 'directory', 'transcript_path', 'agent_transcript_path',
  'url', 'pattern', 'glob', 'filename', 'filenames', 'old_path', 'new_path', 'target_file',
]);

// Whole messages the code compares against, kept verbatim in shape mode:
// OpenCode's aborted tool and dismissed question.
const KNOWN_MESSAGES = new Set([
  'Tool execution aborted',
  'The user dismissed this question',
]);
// An editor's exit-status line (Claude Code's `Exit code 1`), kept on the
// first or last line of otherwise anonymised text: the predicate rules and
// the inferred exit code read it. Same shape as state-machine's trailer.
const EXIT_LINE_RE = /^\s*(?:exit\s+(?:code|status)|exited\s+with(?:\s+(?:exit\s+)?(?:code|status))?)[:=\s]+\d{1,3}\s*\.?\s*$/i;

// The words a command or path keeps. Command names, subcommands and task
// names the classifier tables test, tool names (split at camelCase), file
// extensions and common directory names. Everything else becomes `x`.
// A word here says only that a command or path used it. A few tool names are
// also ordinary words (`ava`, `fly`, `kind`), so a commit message can keep
// one; none is specific to a person, a project or a secret.
const VOCAB = new Set(`
  cat less more head tail grep egrep fgrep rg ag ack find fd ls dir wc bat file stat echo printf which where
  type diff cmp comm tree du df pwd cd pushd popd journalctl sort uniq cut tr nl column paste tac rev fold fmt
  expand unexpand jq yq xxd od hexdump strings basename dirname realpath readlink md5sum sha1sum sha256sum shasum
  findstr rm mv cp mkdir rmdir touch chmod chown chgrp ln sed awk gawk xargs env export set unset source alias eval
  exec bash sh zsh dash fish ksh pwsh powershell cmd sudo doas time timeout nohup nice kill killall pkill pgrep ps
  top htop lsof tee true false exit return if then else elif fi for do done while until case esac in function
  select test seq sleep wait date whoami id uname hostname clear history open start code vim vi nano emacs man help
  tar gzip gunzip zip unzip xz bzip2 curl wget ssh scp rsync ping nc netstat dig nslookup make cmake ninja meson gcc
  cc clang ld ar strip gdb lldb valgrind strace perf get content gc string sls child item gci gi path resolve
  location gl sl write output host measure object where format table list out remove new copy move invoke
  expression web request command no profile execution policy bypass encoding utf8 null dev
  git gh hub npm npx yarn pnpm pnpx bun bunx node nodejs deno tsx ts tsc esbuild swc babel webpack vite rollup
  parcel turbo nx bazel bazelisk lerna corepack nvm volta python python3 py pip pip3 pipx uv uvx poetry pdm conda
  mamba virtualenv venv pytest unittest nosetests tox nox mypy ruff black flake8 pylint isort jest vitest mocha
  ava jasmine karma playwright cypress puppeteer rspec minitest phpunit pest cargo rustc rustup clippy rustfmt go
  gofmt golangci lint java javac kotlin kotlinc gradle gradlew mvn mvnw maven sbt scala dotnet msbuild nuget swift
  swiftc xcodebuild xcrun zig ruby gem bundle bundler rake rails irb php composer artisan perl lua elixir mix
  erl ghc cabal stack dune opam flutter dart pub docker podman compose buildx kubectl helm minikube kind terraform
  tofu ansible vagrant aws gcloud az firebase vercel netlify heroku wrangler fly brew apt yum dnf pacman apk zypper
  choco winget scoop snap flatpak torchrun deepspeed accelerate unsloth jupyter ipython prettier eslint biome
  stylelint oxlint dprint sqlite sqlite3 psql mysql redis mongosh
  install i add ci run x build compile tests testing e2e coverage cov format check typecheck types clean
  start serve server watch preview deploy publish release debug dist all commit push pull fetch merge rebase
  checkout switch branch tag status log show reflog stash pop apply drop reset restore revert cherry pick clone init
  remote config describe blame shortlog parse files worktree submodule update upgrade uninstall view checks pr
  issue repo api auth login logout logs images inspect delete create up down restart stop version info audit
  outdated why link unlink pack prune cache verify integration surefire failsafe connected unit spec specs bench
  benchmark doc docs generate gen migrate migration train training fit eval evaluate finetune fine tune epoch
  epochs learning rate lr require sync lock freeze activate shell console repl only grep
  origin upstream main master develop head fixup squash amend message edit force lease hard soft staged cached
  name oneline graph porcelain short ref refs heads remotes tags
  home users user root tmp temp var usr bin sbin etc opt local share lib include src sources app apps packages
  package pkg pkgs internal scripts script tools tool configs public static assets index target modules vendor
  components component pages page routes utils util helpers common core models model views controllers services
  service hooks styles style fixtures fixture mocks mock migrations db data claude codex opencode openclaw
  projects project subagents subagent agent agents settings plugins plugin worktrees workspace workspaces github
  workflows desktop documents downloads library application support appdata roaming program windows system32
  js mjs cjs jsx mts cts d json jsonc jsonl json5 md mdx txt rst yml yaml toml ini cfg conf sh ps1 psm1 bat exe
  dll so dylib o pyi pyc ipynb rb mod sum rs kt kts c h cpp cxx hpp cs fs vb m mm pl ex exs hs ml vue svelte astro
  html htm css scss sass xml svg png jpg jpeg gif webp ico pdf csv tsv sql db env example sample dockerfile
  makefile procfile gemfile rakefile readme license changelog contributing gitignore gitattributes editorconfig
  npmrc nvmrc tsconfig jsconfig min map wasm gz tgz bz2 bak orig patch
  read multi notebook search task todo plan mode enter ask question skill shell mcp resource resources cron
  schedule wakeup send agents monitor report findings artifact workflow str replace sessions process browser canvas
  webfetch websearch todowrite todoread multiedit codesearch lsp batch query lookup modify insert append upload import
  manage resize draft download whoami gitlab linear slack notion filesystem context7 sentry figma atlassian jira
  confluence asana google gmail drive calendar todoist memory sequential thinking postgres brave exa tavily
  firecrawl stripe supabase cloudflare kubernetes chrome devtools ide computer use anthropic openai
  pythonpath tmpdir lang term https http file localhost
  recurse filter force exclude literal depth value raw first last property unique descending nonewline
  iname maxdepth mindepth mtime newer print print0 empty executable eof
`.trim().split(/\s+/));

// -- Text rules ----------------------------------------------------------

// Length class: exact below 100, else two significant digits -- enough to
// know which size rules a text crossed (the 80K scan window, the 1 MB cap),
// not enough to fingerprint it.
function lenClass(n) {
  if (n < 100) return n;
  const p = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / p) * p;
}

// Lines as state-machine's lineCount counts them: a final newline ends the
// last line rather than starting another.
function lineCount(s) {
  if (!s) return 0;
  let n = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return s.endsWith('\n') ? n : n + 1;
}

// `<text len~N lines=L>`, plus ` eol` when the text ended with a newline.
// The line count is exact: an edit's +N -M diff is counted from it.
function placeholder(s) {
  return `<text len~${lenClass(s.length)} lines=${lineCount(s)}${s.endsWith('\n') ? ' eol' : ''}>`;
}
const PLACEHOLDER_RE = /<text len~(\d{1,9}) lines=(\d{1,9})( eol)?>/g;

// Free text: a placeholder, except a known message (verbatim) and an
// exit-status line on the first or last line (kept, around a placeholder).
function freeText(s) {
  if (!s) return s;
  if (KNOWN_MESSAGES.has(s)) return s;
  let first = '';
  let last = '';
  let body = s;
  const nl = body.indexOf('\n');
  const firstLine = nl === -1 ? body : body.slice(0, nl);
  if (firstLine.length <= 64 && EXIT_LINE_RE.test(firstLine)) {
    first = firstLine;
    body = nl === -1 ? '' : body.slice(nl + 1);
  }
  const trimmed = body.endsWith('\n') ? body.slice(0, -1) : body;
  const lastNl = trimmed.lastIndexOf('\n');
  const lastLine = trimmed.slice(lastNl + 1);
  if (body && lastLine.length <= 64 && EXIT_LINE_RE.test(lastLine)) {
    last = body.slice(lastNl + 1);
    body = lastNl === -1 ? '' : trimmed.slice(0, lastNl + 1);
  }
  if (!first && !last) return placeholder(s);
  if (!body && !last) return s;   // the whole text is the exit line (and its newline)
  const parts = [];
  if (first) parts.push(first);
  if (body) parts.push(placeholder(body.endsWith('\n') && last ? body.slice(0, -1) : body));
  if (last) parts.push(last);
  return parts.join('\n');
}

const isAsciiAlnum = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
// Non-ASCII counts as a letter: a name in any script is still a name.
const isWordChar = (c) => isAsciiAlnum(c) || c >= 0x80;
const isDigit = (c) => c >= 48 && c <= 57;
// Where a new shell word starts. Quote characters are transparent, so a
// flag inside `bash -lc '... --grep x'` is still a flag.
const WORD_BREAKS = new Set([' ', '\t', '\n', '\r', ';', '|', '&', '(', ')', '{', '}', '<', '>', '`']);
const QUOTES = new Set(['"', '\'']);

// One token -- a maximal run of word characters -- split into camelCase
// words and digit runs. Known words survive with their case. In a token
// whose words are all known, digit runs of up to four survive (`python3`,
// `head -40`, `2>&1`). Anything else -- unknown words, longer digit runs, all
// digits of a token that has an unknown word -- becomes one `x` per run of
// them: `unitTest` -> `xTest`, a uuid fragment `3f2a9c1e` -> `x`. A lone
// letter survives only as a token of its own (`npm i`, `C:`), never as a hex
// digit inside an id.
const SUBRUN_RE = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+|[^\x00-\x7f]+/g;
function shapeToken(tok) {
  if ((tok.length === 1 && tok.charCodeAt(0) < 0x80) || VOCAB.has(tok.toLowerCase())) return tok;
  const parts = tok.match(SUBRUN_RE) || [];
  const isKnown = (p) => p.length > 1 && p.charCodeAt(0) < 0x80 && !isDigit(p.charCodeAt(0)) && VOCAB.has(p.toLowerCase());
  const unknown = parts.some(p => !isDigit(p.charCodeAt(0)) && !isKnown(p));
  let out = '';
  let replaced = false;   // the previous part already became `x`
  for (const p of parts) {
    const keep = isKnown(p) || (!unknown && isDigit(p.charCodeAt(0)) && p.length <= 4);
    if (keep) out += p;
    else if (!replaced) out += 'x';
    replaced = !keep;
  }
  return out;
}

// An IPv4 address is four short numbers, each of which would survive: it is
// no command shape, and it names a host. One linear pass before the words.
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;

// The shape rule for commands and paths: every word not in VOCAB becomes
// `x`; flags (`-rf`, `--in-place`, the name part of `--grep=...`), quotes,
// escapes, operators, redirects, separators and line structure survive.
// Common words in VOCAB survive inside quotes too -- a wrapped script
// (`bash -lc '...'`) is all quotes, and its command words are the point --
// so `git commit -m "fix acme login"` -> `git commit -m "x x login"`;
// `/home/alice/src/app.test.ts` -> `/home/x/src/x.test.ts`. Linear.
function shapeText(s) {
  s = s.replace(IPV4_RE, 'x.x.x.x');
  let out = '';
  let wordStart = true;
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (isWordChar(c)) {
      let j = i + 1;
      while (j < n && isWordChar(s.charCodeAt(j))) j++;
      out += shapeToken(s.slice(i, j));
      i = j;
      wordStart = false;
      continue;
    }
    if (c === 45 && wordStart) {   // '-' starting a word: a flag
      let j = i;
      while (j < n && s.charCodeAt(j) === 45) j++;
      let k = j;
      while (k < n && (isAsciiAlnum(s.charCodeAt(k)) || s.charCodeAt(k) === 45)) k++;
      const dashes = j - i;
      const len = k - j;
      // A short cluster (`-rf`, `-lc`) or a long option. A long single-dash
      // run is no flag cluster but a value glued on (`-pS3cret`): words.
      if (len && ((dashes >= 2 && len <= 40) || (dashes === 1 && len <= 4))) {
        out += s.slice(i, k);
        i = k;
      } else {
        out += s.slice(i, j);
        i = j;
      }
      wordStart = false;
      continue;
    }
    const ch = s[i];
    out += ch;
    if (WORD_BREAKS.has(ch)) wordStart = true;
    else if (!QUOTES.has(ch)) wordStart = false;
    i++;
  }
  return out;
}

// -- The anonymiser ------------------------------------------------------

function isToken(s, re = TOKEN_RE) {
  return re.test(s);
}

// An object key survives when it looks like a field name; any other key (a
// map keyed by file path or e-mail) becomes `<key N>`, N its position.
const SAFE_KEY_RE = /^(?:[A-Za-z_$][\w$.:-]{0,63}|\d{1,6})$/;

function setOwn(obj, key, value) {
  // defineProperty, so a `__proto__` key stays an ordinary own key.
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function shapeString(key, s, inPatch, pseudonym) {
  if (s === '') return s;
  const kind = ID_KINDS[key];
  if (kind) return pseudonym(kind, s);
  if (TOOL_KEYS.has(key)) {
    if (s.length > 256) return placeholder(s);
    return s.startsWith('mcp__') ? `mcp__${shapeText(s.slice(5))}` : shapeText(s);
  }
  if (MODEL_KEYS.has(key)) return isToken(s, MODEL_RE) ? s : placeholder(s);
  if (key === 'name') return ERROR_NAME_RE.test(s) ? s : freeText(s);
  if (ENUM_KEYS.has(key)) return isToken(s) ? s : freeText(s);
  if (SHAPE_KEYS.has(key)) return shapeText(s);
  // structuredPatch hunks: diffFromPatch counts lines by their first
  // character, so the marker survives and the content does not.
  if (inPatch && key === 'lines') return /^[-+ \\]/.test(s) ? `${s[0]}x` : 'x';
  return freeText(s);
}

function shapeNumber(key, n) {
  if (ENUM_KEYS.has(key)) return n;
  // Small integers are counts, offsets, codes, sequence numbers, durations;
  // anything else (an epoch, an account number, a coordinate) becomes 0.
  return Number.isInteger(n) && Math.abs(n) <= 1e6 ? n : 0;
}

// Shape-mode anonymisation of one parsed payload. Pure apart from the
// pseudonym function; keeps every key (see SAFE_KEY_RE) and every value's
// type. Never throws on anything JSON.parse can produce, nor on a cycle.
function anonymise(value, { pseudonym } = {}) {
  const pseud = pseudonym || makePseudonymiser('');
  const walk = (v, key, inPatch, depth) => {
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return shapeNumber(key, v);
    if (typeof v === 'string') return shapeString(key, v, inPatch, pseud);
    if (Array.isArray(v)) {
      if (depth >= MAX_DEPTH) return [];
      const out = new Array(v.length);
      for (let i = 0; i < v.length; i++) out[i] = walk(v[i], key, inPatch, depth + 1);
      return out;
    }
    if (typeof v === 'object') {
      const out = {};
      if (depth >= MAX_DEPTH) return out;
      const keys = Object.keys(v);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const outKey = SAFE_KEY_RE.test(k) ? k : `<key ${i}>`;
        setOwn(out, outKey, walk(v[k], k, inPatch || k === 'structuredPatch', depth + 1));
      }
      return out;
    }
    return null;   // undefined, functions, symbols: not JSON
  };
  return walk(value, '', false, 0);
}

// Rewrites every id (the values under ID_KINDS keys) through fn(kind, id).
// The fixture importer renumbers pseudonyms with it.
function mapIds(value, fn) {
  const walk = (v, key, depth) => {
    if (typeof v === 'string') return (ID_KINDS[key] && v) ? fn(ID_KINDS[key], v) : v;
    if (v === null || typeof v !== 'object' || depth >= MAX_DEPTH) return v;
    if (Array.isArray(v)) return v.map(x => walk(x, key, depth + 1));
    const out = {};
    for (const k of Object.keys(v)) setOwn(out, k, walk(v[k], k, depth + 1));
    return out;
  };
  return walk(value, '', 0);
}

// argv in shape mode: flags and plain tokens (event names, `--editor`,
// `codex`, a model after `-m`) survive; anything else -- a prompt, a path --
// is text.
function shapeArgv(argv) {
  return argv.map(a => {
    const s = typeof a === 'string' ? a : String(a);
    return /^[A-Za-z0-9_=.:@+-]{1,64}$/.test(s) ? s : freeText(s);
  });
}

// -- Payloads too large to keep ------------------------------------------

// The envelope fields of a payload over MAX_INPUT, as update-state.js's
// fallback extracts them: from the head, except tool_use_id, which Claude
// Code serializes after tool_response and so is read from the tail (the
// last match: a response may quote the key itself). The adapters' own
// spellings (sessionId, type, tool) are covered too.
const HEAD_FIELDS = {
  session_id: /"session_?id"\s*:\s*"([^"\\]{1,256})"/i,
  agent_id: /"agent_id"\s*:\s*"([^"\\]{1,256})"/,
  agent_type: /"agent_type"\s*:\s*"([^"\\]{1,256})"/,
  hook_event_name: /"hook_event_name"\s*:\s*"([^"\\]{1,64})"/,
  source: /"source"\s*:\s*"([^"\\]{1,64})"/,
  tool_name: /"(?:tool_name|toolName|tool)"\s*:\s*"([^"\\]{1,256})"/,
  type: /"(?:type|event)"\s*:\s*"([^"\\]{1,64})"/,
};
function extractIds(raw, tail) {
  const out = {};
  for (const [k, re] of Object.entries(HEAD_FIELDS)) {
    // A hook payload names its event; its first `"type"` is some tool's.
    if (k === 'type' && out.hook_event_name) continue;
    const m = re.exec(raw);
    if (m) out[k] = m[1];
  }
  const re = /"tool_use_id"\s*:\s*"([^"\\]{1,256})"/g;
  let m;
  let last = '';
  while ((m = re.exec(tail || ''))) last = m[1];
  if (last) out.tool_use_id = last;
  return out;
}

// -- Records ----------------------------------------------------------------

// The event a payload names: argv's for a hook, else its own.
function payloadEvent(payload) {
  if (!payload || typeof payload !== 'object') return '';
  for (const k of ['hook_event_name', 'type', 'event']) {
    if (typeof payload[k] === 'string' && payload[k]) return payload[k];
  }
  return '';
}

// One record, as appended. entry: { source, editor, event?, argv?, payload }
// for a parsed payload, or { source, editor, event?, argv?, raw, tail?,
// truncated? } for stdin text as received (update-state.js, an adapter's
// fallback).
function buildRecord(entry, mode, pseudonym, now) {
  const shape = mode !== 'full';
  const token = (v, dflt) => {
    const s = typeof v === 'string' ? v : '';
    return shape ? (isToken(s) ? s : dflt) : (s || dflt);
  };
  const rec = { v: RECORD_VERSION, at: now, source: token(entry.source, 'unknown'), editor: token(entry.editor, '') };
  let payload = entry.payload;
  let parsed = true;
  if (typeof entry.raw === 'string') {
    if (entry.truncated) {
      rec.truncated = true;
      rec.over = MAX_INPUT;
      payload = extractIds(entry.raw, entry.tail !== undefined ? entry.tail : entry.raw.slice(-4096));
    } else {
      try { payload = JSON.parse(entry.raw); } catch {
        parsed = false;
        rec.unparsed = true;
        payload = entry.raw;
      }
    }
  }
  rec.event = token(entry.event || payloadEvent(payload), '');
  rec.mode = shape ? 'shape' : 'full';
  if (Array.isArray(entry.argv)) rec.argv = shape ? shapeArgv(entry.argv) : entry.argv.slice();
  if (!parsed) rec.payload = shape ? freeText(payload) : payload.slice(0, MAX_UNPARSED_CHARS);
  else rec.payload = shape ? anonymise(payload, { pseudonym }) : payload;
  return rec;
}

function headerRecord(mode, now) {
  let version = '';
  try { version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; } catch {}
  return { v: RECORD_VERSION, kind: 'header', at: now, mode, platform: process.platform,
    node: process.version, codeCrumb: version };
}

// Appends one record. Returns true when something was written. Never throws:
// it runs inside hooks, and a broken recorder must not cost the editor its
// event (hook code's silent-failure rule).
function record(entry) {
  try {
    const mode = recordMode();
    if (!mode || !entry) return false;
    const now = Date.now();
    const file = recordFile(process.env, now);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    if (size >= MAX_FILE_BYTES) return false;
    const pseudonym = mode === 'shape' ? makePseudonymiser(readKey(dir)) : null;
    const rec = buildRecord(entry, mode, pseudonym, now);
    let line = JSON.stringify(rec);
    if (line.length > MAX_LINE_CHARS) {
      line = JSON.stringify({ v: RECORD_VERSION, at: now, source: rec.source, editor: rec.editor,
        event: rec.event, mode: rec.mode, tooBig: true, chars: line.length });
    }
    // A new file opens with a header: what recorded it, on what. Two hooks
    // creating it at once may both write one; readers skip every header.
    const text = (size === 0 ? JSON.stringify(headerRecord(rec.mode, now)) + '\n' : '') + line + '\n';
    // One append per record: O_APPEND keeps parallel hooks' lines whole.
    fs.appendFileSync(file, text, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// -- Replay helpers ----------------------------------------------------------

// Filler for a placeholder: L lines of `~`, about N characters in all, a
// final newline when the original had one. Deterministic, matches none of
// the classifier's failure patterns, keeps an edit's line counts, and is no
// token (TOKEN_RE), so recording a replay turns it back into the same
// placeholder. The odd characters go to the LAST lines: without a final
// newline the last line must not be empty, or lineCount would see one line
// fewer.
function fillerText(len, lines, eol) {
  if (!lines) return '';
  const newlines = lines - 1 + (eol ? 1 : 0);
  const content = Math.max(eol ? 0 : 1, Math.min(len, 8 * MAX_INPUT) - newlines);
  const base = Math.floor(content / lines);
  const extra = content % lines;
  const out = new Array(lines);
  for (let i = 0; i < lines; i++) out[i] = '~'.repeat(base + (i >= lines - extra ? 1 : 0));
  return out.join('\n') + (eol ? '\n' : '');
}

function expandText(s) {
  return s.indexOf('<text len~') === -1 ? s
    : s.replace(PLACEHOLDER_RE, (_, len, lines, eol) => fillerText(+len, Math.min(+lines, 1e6), !!eol));
}

// Every placeholder in a recorded payload, expanded for replay.
function expandPlaceholders(value, depth = 0) {
  if (typeof value === 'string') return expandText(value);
  if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map(v => expandPlaceholders(v, depth + 1));
  const out = {};
  for (const k of Object.keys(value)) setOwn(out, k, expandPlaceholders(value[k], depth + 1));
  return out;
}

// The stdin text a recorded payload replays as. A truncated marker becomes a
// payload over MAX_INPUT with its envelope ids where the real one had them:
// tool_use_id serialized after the oversized tool_response.
function replayInput(rec) {
  if (rec.unparsed) return typeof rec.payload === 'string' ? expandText(rec.payload) : '';
  const payload = expandPlaceholders(rec.payload);
  if (!rec.truncated) return JSON.stringify(payload);
  const ids = payload && typeof payload === 'object' ? payload : {};
  const head = {};
  for (const k of Object.keys(ids)) if (k !== 'tool_use_id') head[k] = ids[k];
  const body = { ...head, tool_input: {}, tool_response: { stdout: '~'.repeat(MAX_INPUT + 65536) } };
  if (ids.tool_use_id) body.tool_use_id = ids.tool_use_id;
  return JSON.stringify(body);
}

module.exports = {
  record, recordMode, recordFile, buildRecord, anonymise, mapIds, shapeText, shapeArgv, freeText,
  placeholder, lineCount, lenClass, makePseudonymiser, readKey, extractIds,
  expandPlaceholders, expandText, fillerText, replayInput,
  ID_KINDS, ENUM_KEYS, SHAPE_KEYS, VOCAB, MAX_FILE_BYTES, MAX_INPUT, KEY_FILE,
};
