#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Setup -- configures hooks for supported editors    |
// |  Works on Windows, macOS, and Linux                            |
// |                                                                |
// |  Usage:                                                        |
// |    node setup.js              (Claude Code -- default)         |
// |    node setup.js claude       (Claude Code -- explicit)        |
// |    node setup.js uninstall    (remove Claude + Codex hooks)    |
// |    node setup.js codex        (Codex CLI native hooks)         |
// |    node setup.js codex-notify (Codex legacy notify channel)    |
// |    node setup.js opencode     (OpenCode -- print instructions) |
// |    node setup.js opencode --install                            |
// |                               (write opencode.json for real)   |
// |    node setup.js openclaw     (OpenClaw / Pi)                  |
// |    node setup.js --autolaunch (only flip the autolaunch pref)  |
// |    node setup.js doctor       (read-only health check; exit 1  |
// |                               when it finds a problem)         |
// |                                                                |
// |  Every installer is also a module: setupClaude() /             |
// |  uninstallClaude() / setupCodex() / uninstallCodex() take      |
// |  { settingsPath | hooksPath, log }, and setupOpenCode() /      |
// |  uninstallOpenCode() take { configPath, pluginPath, install,   |
// |  log } -- so tests never touch a real settings.json,           |
// |  hooks.json or opencode.json.                                  |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { HOME, QUIT_FLAG_FILE, savePrefs, writeJsonAtomic } = require('./lib/shared');

const HOOK_SCRIPT = path.resolve(__dirname, 'update-state.js');

// Normalise to forward slashes -- works in Node on all platforms
// and avoids JSON escaping nightmares with backslashes
const DEFAULT_HOOK_PATH = HOOK_SCRIPT.replace(/\\/g, '/');
const DEFAULT_SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');

// Codex keeps everything under CODEX_HOME when it is set -- codex refuses to
// start unless it then names an existing directory -- and under ~/.codex
// otherwise. Setup used to write ~/.codex regardless, so a CODEX_HOME user
// got hooks codex never read. Resolved per call: tests pass their own env.
function codexHome(env = process.env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(HOME, '.codex');
}
const DEFAULT_CODEX_HOOKS_PATH = path.join(codexHome(), 'hooks.json');

const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop',
  'Notification', 'SubagentStart', 'SubagentStop',
  'TeammateIdle', 'TaskCompleted', 'SessionStart', 'SessionEnd',
  'PreCompact', 'PostCompact', 'PermissionRequest', 'Setup',
  'Elicitation', 'ElicitationResult', 'ConfigChange',
  'InstructionsLoaded', 'StopFailure', 'UserPromptSubmit',
  // The only documented, zero-cost way to follow a /model switch. Codex does
  // not fire it, so it is deliberately absent from CODEX_HOOK_EVENTS below.
  'PostModelSwitch',
  // Claude Code 2.1.300: the auto-mode classifier refused a tool call. It is
  // the only word that the denied call will never run. Not a Codex event.
  'PermissionDenied',
];

// The per-tool events run with `"async": true` ("runs in background without
// blocking", Claude Code 2.1.300). On Windows every hook is Git Bash plus
// node, ~55-85 ms, so a synchronous Pre + Post blocked the editor ~170 ms on
// every tool call. update-state.js orders their writes itself (see "Async
// hook ordering" there). Everything else stays synchronous -- a Stop, a
// prompt or a permission request must land in the order it happened, and
// the async guards measure against exactly those.
const ASYNC_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];

// Codex fires a subset of the same event names (no Notification, no
// PostToolUseFailure), plus one of its own: Interrupt, which it runs INSTEAD
// of Stop when the user presses Esc (0.156; PostCompact arrived with it).
// Registering an event codex does not know about only leaves dead config
// behind -- hooks.json is parsed leniently, so an older codex ignores the key
// and still runs every other hook (checked against 0.156 with an unknown key).
const CODEX_HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PermissionRequest', 'PreCompact', 'PostCompact',
  'SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop',
  'UserPromptSubmit', 'Stop', 'Interrupt',
];

// -- Claude Code Setup -----------------------------------------------

function buildFaceHooks(hookPath) {
  const faceHooks = {};
  for (const event of HOOK_EVENTS) {
    faceHooks[event] = [
      {
        matcher: '',
        hooks: [{
          type: 'command',
          command: `node "${hookPath}" ${event}`,
          ...(ASYNC_HOOK_EVENTS.includes(event) ? { async: true } : {}),
        }],
      },
    ];
  }
  return faceHooks;
}

// Bring our installed commands for `event` (at exactly hookPath) to the async
// flag buildFaceHooks gives that event. An install from before the async
// change matches by path and used to be reported "already installed" for
// good; this upgrades it in place instead of adding a second entry. Returns
// how many commands changed.
function syncAsyncFlags(entries, event, hookPath) {
  const want = ASYNC_HOOK_EVENTS.includes(event);
  let changed = 0;
  for (const e of entries) {
    if (!Array.isArray(e?.hooks)) continue;
    for (const hh of e.hooks) {
      if (!isOurCommand(hh) || !hh.command.includes(hookPath)) continue;
      if (want && hh.async !== true) { hh.async = true; changed++; }
      else if (!want && 'async' in hh) { delete hh.async; changed++; }
    }
  }
  return changed;
}

// One hook command that runs an update-state.js (ours, at any path). It must
// end in the argv shape we install -- `update-state.js" [--editor x] <Event>`,
// with a real hook event -- so an unrelated script that happens to be called
// update-state.js (a tmux status helper, `update-state.js busy`) is never
// mistaken for a moved Code Crumb repo. Every event ever installed is still in
// HOOK_EVENTS or CODEX_HOOK_EVENTS, so old installs still match.
const ALL_HOOK_EVENTS = [...new Set([...HOOK_EVENTS, ...CODEX_HOOK_EVENTS])];
const OUR_COMMAND_RE = new RegExp(
  `update-state\\.js["']?\\s+(?:--editor[=\\s]\\S+\\s+)?(?:${ALL_HOOK_EVENTS.join('|')})\\s*$`);
function isOurCommand(hh) {
  return typeof hh?.command === 'string' && OUR_COMMAND_RE.test(hh.command);
}

// A matcher group that holds at least one of our commands.
function isOurHook(entry) {
  return !!entry?.hooks?.some(isOurCommand);
}

// Remove our commands from a list of matcher groups. Filtering is per
// command, not per group: a user who put their own hook in the same group as
// ours keeps it, and a group is dropped only once nothing of theirs is left.
// (Filtering whole groups deleted every co-located user hook on uninstall and
// on a moved-repo repair.) Returns { kept, removed } -- removed counts commands.
function stripOurHooks(entries) {
  const kept = [];
  let removed = 0;
  for (const e of entries) {
    if (!isOurHook(e)) { kept.push(e); continue; }
    const others = e.hooks.filter(hh => !isOurCommand(hh));
    removed += e.hooks.length - others.length;
    if (others.length) kept.push({ ...e, hooks: others });
  }
  return { kept, removed };
}

// Our hook entry pointing at exactly this hookPath.
function hasExactPath(entry, hookPath) {
  return !!entry?.hooks?.some(hh => typeof hh?.command === 'string' && hh.command.includes(hookPath));
}

// Byte-exact command match. The Codex installer needs this rather than a path
// match: a legacy entry can point at the right update-state.js and still be
// missing the `--editor codex` tag that keeps sessions from being labelled
// "claude", and that entry must be rewritten, not reported as installed.
function hasExactCommand(entry, command) {
  return !!entry?.hooks?.some(hh => typeof hh?.command === 'string' && hh.command === command);
}

// Read a JSON config file. A missing file means "start fresh"; anything else
// that goes wrong (unreadable, invalid JSON, not an object) means "do not
// touch it" -- the old behaviour silently replaced a broken settings.json
// with just our hooks, wiping permissions, env, MCP servers and everything
// else. One helper for all three installers: Claude settings.json, Codex
// hooks.json and OpenCode opencode.json. `label` names the file in the log.
function readJsonConfig(filePath, log, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      log(`  [..] No existing ${label} found, creating new`);
      return { settings: {}, existed: false, raw: null };
    }
    log(`  [!!] Could not read ${filePath}: ${err.message}`);
    log('       Leaving it untouched. Fix or move the file, then re-run setup.');
    return { error: err };
  }
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch (err) {
    log(`  [!!] ${filePath} is not valid JSON (${err.message}).`);
    log('       Leaving it untouched so nothing is lost. Fix the file, then re-run setup.');
    return { error: err };
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    log(`  [!!] ${filePath} is not a JSON object. Leaving it untouched.`);
    return { error: new Error(`${label} is not an object`) };
  }
  log(`  [ok] Found existing ${label}`);
  return { settings, existed: true, raw };
}

// Write an owner-only backup: a settings.json or opencode.json can hold API
// keys, and a default-mode (0644) .bak put them in a world-readable file next
// to the 0600 original. A leftover .bak is removed first, so the secrets are
// never written into a file with its old mode (and a read-only one left by a
// read-only settings file cannot stop the backup being refreshed).
function writeBackup(bakPath, raw) {
  try {
    try { fs.unlinkSync(bakPath); } catch {}
    fs.writeFileSync(bakPath, raw, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(bakPath, 0o600); } catch {}
    return true;
  } catch {
    return false;
  }
}

// Back up the previous file, then write atomically, keeping the file mode.
function writeSettings(settingsPath, settings, existed, raw, log) {
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let mode = 0o600;
  if (existed) {
    try { mode = fs.statSync(settingsPath).mode & 0o777; } catch {}
    if (writeBackup(settingsPath + '.bak', raw)) {
      log(`  [ok] Backup written to ${settingsPath}.bak`);
    }
  }
  const ok = writeJsonAtomic(settingsPath, JSON.stringify(settings, null, 2) + '\n', mode || 0o600);
  if (!ok) log(`  [!!] Failed to write ${settingsPath}`);
  return ok;
}

// `baseDir` is where the install lives (a test seam; production is __dirname).
// The demo hint is printed only when demo/single.js is actually there:
// package.json's "files" whitelist keeps the demos out of the npm tarball, so
// an npm install was told to run a file it does not have (Cannot find module).
function printClaudeUsage(settingsPath, log, baseDir = __dirname) {
  const rendererPath = path.resolve(baseDir, 'renderer.js').replace(/\\/g, '/');
  const demoFile = path.resolve(baseDir, 'demo', 'single.js');
  const demoPath = demoFile.replace(/\\/g, '/');
  const demoHint = fs.existsSync(demoFile)
    ? `
  3. To preview all expressions:
     node "${demoPath}"
`
    : '';
  // Same rule for the plugin route: the npm tarball does not ship
  // .claude-plugin/, so `marketplace add <this folder>` on an npm install
  // fails with "Marketplace file not found" -- point it at GitHub instead.
  const marketplace = fs.existsSync(path.resolve(baseDir, '.claude-plugin', 'marketplace.json'))
    ? `"${path.resolve(baseDir).replace(/\\/g, '/')}"`
    : 'Skelly0/code-crumb';
  const pluginHint = `
  Plugin install (alternative -- works with marketplace):
     claude plugin marketplace add ${marketplace}
     claude plugin install code-crumb@code-crumb
     Use ONE of the two: with both the manual hooks and the plugin
     installed every event fires twice and the counters double.
`;
  log(`
  ${'─'.repeat(42)}

  To use Code Crumb:

  1. Open a terminal and run:
     node "${rendererPath}"

  2. Use Claude Code as normal in another terminal.
     The face will react to what Claude is doing!
${demoHint}${pluginHint}
  To uninstall the manual hooks:
     node setup.js uninstall
  Or the plugin:
     claude plugin uninstall code-crumb
  Settings file:
     ${settingsPath}

  ${'─'.repeat(42)}
`);
}

// Install (or repair) the Claude Code hooks.
// opts: { settingsPath, hookPath, log, quiet }
// Returns { ok, modified, added, replaced, error? }.
function setupClaude(opts = {}) {
  const settingsPath = opts.settingsPath || DEFAULT_SETTINGS_PATH;
  const hookPath = opts.hookPath || DEFAULT_HOOK_PATH;
  const log = opts.log || console.log;
  const faceHooks = buildFaceHooks(hookPath);

  log('\n  Code Crumb Setup (Claude Code)');
  log('  ' + '='.repeat(40) + '\n');
  log(`  Platform: ${process.platform}`);
  log(`  Home:     ${HOME}`);
  log(`  Hook:     ${hookPath}\n`);

  const read = readJsonConfig(settingsPath, log, 'Claude settings');
  if (read.error) return { ok: false, modified: false, added: 0, replaced: 0, error: read.error };
  const { settings, existed, raw } = read;

  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }

  let added = 0;
  let replaced = 0;
  let upgraded = 0;
  for (const [event, hookConfigs] of Object.entries(faceHooks)) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    const entries = settings.hooks[event];

    if (entries.some(e => hasExactPath(e, hookPath))) {
      if (syncAsyncFlags(entries, event, hookPath)) {
        upgraded++;
        log(`  ~ Updated ${event} hook (${ASYNC_HOOK_EVENTS.includes(event) ? 'async' : 'sync'})`);
      } else {
        log(`  [ok] ${event} hook already installed`);
      }
      continue;
    }
    // A Code Crumb entry with a different path: the repo moved. Replace it
    // instead of reporting "already installed" and leaving a dead hook.
    if (entries.some(isOurHook)) {
      settings.hooks[event] = stripOurHooks(entries).kept.concat(hookConfigs);
      replaced++;
      log(`  ~ Updated ${event} hook path`);
      continue;
    }
    entries.push(...hookConfigs);
    added++;
    log(`  + Added ${event} hook`);
  }

  const modified = added + replaced + upgraded > 0;
  if (modified) {
    if (!writeSettings(settingsPath, settings, existed, raw, log)) {
      return { ok: false, modified: false, added, replaced, upgraded, error: new Error('write failed') };
    }
    log(`\n  Hooks written to ${settingsPath}`);
  } else {
    log('\n  All hooks already installed');
  }

  if (!opts.quiet) printClaudeUsage(settingsPath, log);
  return { ok: true, modified, added, replaced, upgraded };
}

// Remove every Code Crumb hook entry (any path) and drop event arrays that
// end up empty. opts: { settingsPath, log }. Returns { ok, removed, error? }.
function uninstallClaude(opts = {}) {
  const settingsPath = opts.settingsPath || DEFAULT_SETTINGS_PATH;
  const log = opts.log || console.log;

  log('\n  Code Crumb Uninstall (Claude Code)');
  log('  ' + '='.repeat(40) + '\n');

  const read = readJsonConfig(settingsPath, log, 'Claude settings');
  if (read.error) return { ok: false, removed: 0, error: read.error };
  const { settings, existed, raw } = read;

  let removed = 0;
  if (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)) {
    for (const event of Object.keys(settings.hooks)) {
      const entries = settings.hooks[event];
      if (!Array.isArray(entries)) continue;
      const { kept, removed: n } = stripOurHooks(entries);
      if (!n) continue;
      removed += n;
      if (kept.length) settings.hooks[event] = kept;
      else delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }

  if (removed === 0) {
    log('  [ok] No Code Crumb hooks found -- nothing to do');
    return { ok: true, removed: 0 };
  }
  if (!writeSettings(settingsPath, settings, existed, raw, log)) {
    return { ok: false, removed: 0, error: new Error('write failed') };
  }
  log(`  - Removed ${removed} Code Crumb hook entries from ${settingsPath}\n`);
  return { ok: true, removed };
}

// -- Codex CLI Setup (native hooks) ----------------------------------
// Codex 0.146 has a stable hooks system whose stdin payloads are shaped like
// Claude Code's (hook_event_name, session_id, tool_name, tool_input,
// tool_response, ...), so the same update-state.js serves both -- it only has
// to be told which editor it is serving, via `--editor codex`.

function codexHookPath(repoRoot) {
  return path.resolve(repoRoot || __dirname).replace(/\\/g, '/') + '/update-state.js';
}

function buildCodexHooks(repoRoot) {
  const hookPath = codexHookPath(repoRoot);
  const hooks = {};
  for (const event of CODEX_HOOK_EVENTS) {
    hooks[event] = [
      {
        matcher: '',
        hooks: [{
          type: 'command',
          command: `node "${hookPath}" --editor codex ${event}`,
          timeout: 5,
        }],
      },
    ];
  }
  return { hooks };
}

function printCodexUsage(hooksPath, log) {
  const rendererPath = path.resolve(__dirname, 'renderer.js').replace(/\\/g, '/');
  const wrapperPath = path.resolve(__dirname, 'adapters', 'codex-wrapper.js').replace(/\\/g, '/');
  const rule = '\u2500'.repeat(42);
  log(`
  ${rule}

  To use Code Crumb with Codex:

  1. Open a terminal and run:
     node "${rendererPath}"

  2. Use Codex as normal in another terminal.

  The first Codex run after this prompts you once to trust the
  hooks in ${hooksPath} -- say yes, or start Codex with
  --dangerously-bypass-hook-trust in automation.

  Headless runs (codex exec) can also use the wrapper, which reads
  the JSONL event stream directly and needs no hook trust:
     node "${wrapperPath}" "your prompt"

  Legacy turn-level notify channel (no tool-level events):
     node setup.js codex-notify

  To uninstall:
     node setup.js uninstall

  ${rule}
`);
}

// Install (or repair) the Codex native hooks. Same contract as setupClaude:
// opts { hooksPath, configPath, repoRoot, log, quiet }
//   -> { ok, modified, added, replaced, pruned, notifyRemoved, error? }
// The hooks report everything the legacy notify line does and more, and the
// two together wrote the same session twice per turn (the notify write
// erased the hooks' attention stamp), so a Code Crumb notify line found in
// config.toml is taken out on the way.
function setupCodex(opts = {}) {
  const hooksPath = opts.hooksPath || path.join(codexHome(), 'hooks.json');
  const log = opts.log || console.log;
  const hookPath = codexHookPath(opts.repoRoot);
  const faceHooks = buildCodexHooks(opts.repoRoot).hooks;

  log('\n  Code Crumb Setup (Codex CLI)');
  log('  ' + '='.repeat(40) + '\n');
  log(`  Platform: ${process.platform}`);
  log(`  Home:     ${HOME}`);
  log(`  Hook:     ${hookPath}\n`);

  const read = readJsonConfig(hooksPath, log, 'Codex hooks');
  if (read.error) return { ok: false, modified: false, added: 0, replaced: 0, pruned: 0, error: read.error };
  const { settings, existed, raw } = read;

  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }

  let added = 0;
  let replaced = 0;
  let pruned = 0;
  for (const [event, hookConfigs] of Object.entries(faceHooks)) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    const entries = settings.hooks[event];
    const command = hookConfigs[0].hooks[0].command;

    if (entries.some(e => hasExactCommand(e, command))) {
      log(`  [ok] ${event} hook already installed`);
      continue;
    }
    // A Code Crumb entry with a different path or a missing --editor tag:
    // rewrite it rather than leave a hook that mislabels every session.
    if (entries.some(isOurHook)) {
      settings.hooks[event] = stripOurHooks(entries).kept.concat(hookConfigs);
      replaced++;
      log(`  ~ Updated ${event} hook`);
      continue;
    }
    entries.push(...hookConfigs);
    added++;
    log(`  + Added ${event} hook`);
  }

  // Drop our entries from events codex cannot fire (an older install wrote
  // the full Claude Code set here, including Notification).
  for (const event of Object.keys(settings.hooks)) {
    if (CODEX_HOOK_EVENTS.includes(event)) continue;
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    const { kept, removed: n } = stripOurHooks(entries);
    if (!n) continue;
    pruned += n;
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
    log(`  - Removed ${event} hook (codex does not fire it)`);
  }

  const modified = added + replaced + pruned > 0;
  if (modified) {
    if (!writeSettings(hooksPath, settings, existed, raw, log)) {
      return { ok: false, modified: false, added, replaced, pruned, error: new Error('write failed') };
    }
    log(`\n  Hooks written to ${hooksPath}`);
  } else {
    log('\n  All hooks already installed');
  }

  // A failure here leaves the hooks installed: the notify line only costs
  // the duplicate write, and the log says what to remove by hand.
  const configPath = opts.configPath || path.join(path.dirname(hooksPath), 'config.toml');
  const notify = removeCodexNotify({ configPath, log, quiet: true });
  if (notify.removed) log(`  - Removed the legacy notify line from ${configPath} (the hooks replace it)`);

  if (!opts.quiet) printCodexUsage(hooksPath, log);
  return { ok: true, modified, added, replaced, pruned, notifyRemoved: notify.removed };
}

// Remove every Code Crumb entry from $CODEX_HOME/hooks.json (~/.codex).
// opts: { hooksPath, log }. Returns { ok, removed, error? }.
function uninstallCodex(opts = {}) {
  const hooksPath = opts.hooksPath || path.join(codexHome(), 'hooks.json');
  const log = opts.log || console.log;

  log('\n  Code Crumb Uninstall (Codex CLI)');
  log('  ' + '='.repeat(40) + '\n');

  const read = readJsonConfig(hooksPath, log, 'Codex hooks');
  if (read.error) return { ok: false, removed: 0, error: read.error };
  const { settings, existed, raw } = read;

  let removed = 0;
  if (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)) {
    for (const event of Object.keys(settings.hooks)) {
      const entries = settings.hooks[event];
      if (!Array.isArray(entries)) continue;
      const { kept, removed: n } = stripOurHooks(entries);
      if (!n) continue;
      removed += n;
      if (kept.length) settings.hooks[event] = kept;
      else delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }

  if (removed === 0) {
    log('  [ok] No Code Crumb hooks found -- nothing to do');
    return { ok: true, removed: 0 };
  }
  if (!writeSettings(hooksPath, settings, existed, raw, log)) {
    return { ok: false, removed: 0, error: new Error('write failed') };
  }
  log(`  - Removed ${removed} Code Crumb hook entries from ${hooksPath}\n`);
  return { ok: true, removed };
}

// -- Codex CLI Setup (legacy notify channel) -------------------------
// `notify` is Codex's pre-hooks callback (legacy_notify.rs upstream): one
// turn-level event, no tool detail. Kept for older Codex builds.
//
// Code Crumb's only line in config.toml is one top-level `notify = [...]`
// key, so the edits are textual and minimal -- there is no TOML parser here,
// and the rest of the file comes back byte for byte. A UTF-8 BOM stays the
// very first thing (prepending our lines in front of it left the BOM mid-file,
// a TOML parse error that stopped codex starting), and the lines we add use
// the file's own line ending, so a CRLF config never ends up mixed.

const NOTIFY_HEADER = '# Code Crumb integration';

function codexNotifyPath() {
  return path.resolve(__dirname, 'adapters', 'codex-notify.js').replace(/\\/g, '/');
}

// Index just past the line holding text[i], terminator included.
function lineEnd(text, i) {
  const nl = text.indexOf('\n', i);
  return nl === -1 ? text.length : nl + 1;
}

// Net [ ] depth of a piece of one TOML line, outside strings and comments.
function bracketDepth(s) {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') break;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
  }
  return depth;
}

// Every `notify = ...` key in the file, one line or an array spread over
// several, as { start, end, ours, topLevel }: whole-line character ranges
// (end past the last terminator), `ours` when it names codex-notify.js, and
// `topLevel` when no [table] header comes before it -- the only place the
// key means anything to codex.
function findNotifyKeys(text) {
  const keys = [];
  const re = /^[ \t]*notify[ \t]*=/gm;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index;
    let end = lineEnd(text, start);
    let depth = bracketDepth(text.slice(start + m[0].length, end));
    while (depth > 0 && end < text.length) {
      const next = lineEnd(text, end);
      depth += bracketDepth(text.slice(end, next));
      end = next;
    }
    keys.push({
      start, end,
      ours: /codex-notify\.js/.test(text.slice(start, end)),
      topLevel: !/^[ \t]*\[/m.test(text.slice(0, start)),
    });
    re.lastIndex = end;
  }
  return keys;
}

// Read config.toml for an edit. A missing file is empty; anything else that
// goes wrong (a OneDrive or antivirus lock, EACCES) means "do not touch it":
// an empty read would have the write replace the whole config with one line.
// `body` is the text after any BOM, which `bom` keeps for the write back.
function readCodexConfig(configPath, log) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { text: '', bom: '', body: '', existed: false };
    log(`  [!!] Could not read ${configPath} (${err.code || err.message}) -- leaving it untouched.`);
    return { error: err };
  }
  const bom = text.startsWith('﻿') ? '﻿' : '';
  return { text, bom, body: text.slice(bom.length), existed: true };
}

// .bak first, then an atomic write that keeps the file's mode.
function writeCodexConfig(configPath, text, previous, log) {
  let mode = 0o600;
  if (previous !== null) {
    try { mode = fs.statSync(configPath).mode & 0o777; } catch {}
    if (writeBackup(configPath + '.bak', previous)) log(`  [ok] Backup written to ${configPath}.bak`);
  } else {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  }
  return writeJsonAtomic(configPath, text, mode || 0o600);
}

// Take every Code Crumb notify key out of config.toml, with the header
// comment and the blank line setupCodexNotify wrote around it.
// opts: { configPath, log } -> { ok, removed, error? }
function removeCodexNotify(opts = {}) {
  const configPath = opts.configPath || path.join(codexHome(), 'config.toml');
  const log = opts.log || console.log;
  const read = readCodexConfig(configPath, log);
  if (read.error) return { ok: false, removed: 0, error: read.error };
  const ours = findNotifyKeys(read.body).filter(k => k.ours);
  if (!ours.length) {
    if (!opts.quiet) log('  [ok] No Code Crumb notify line found -- nothing to do');
    return { ok: true, removed: 0 };
  }
  let body = read.body;
  for (const k of ours.reverse()) {
    let { start, end } = k;
    // The header line right above it, and then the blank line we left after.
    const prevStart = body.lastIndexOf('\n', start - 2) + 1;
    if (start > 0 && body.slice(prevStart, start).trim() === NOTIFY_HEADER) {
      start = prevStart;
      const after = lineEnd(body, end);
      if (end < body.length && body.slice(end, after).trim() === '') end = after;
    }
    body = body.slice(0, start) + body.slice(end);
  }
  if (!writeCodexConfig(configPath, read.bom + body, read.text, log)) {
    log(`  [!!] Could not write ${configPath}`);
    return { ok: false, removed: 0, error: new Error('write failed') };
  }
  if (!opts.quiet) log(`  - Removed the Code Crumb notify line from ${configPath}`);
  return { ok: true, removed: ours.length };
}

// Register codex-notify.js as codex's notify program.
// opts: { configPath, notifyPath, log, quiet } -> { ok, modified, error? }
function setupCodexNotify(opts = {}) {
  const configPath = opts.configPath || path.join(codexHome(), 'config.toml');
  const notifyPath = opts.notifyPath || codexNotifyPath();
  const log = opts.log || console.log;
  const wrapperPath = path.resolve(__dirname, 'adapters', 'codex-wrapper.js').replace(/\\/g, '/');
  const rendererPath = path.resolve(__dirname, 'renderer.js').replace(/\\/g, '/');
  const line = `notify = ["node", "${notifyPath}"]`;

  log('\n  Code Crumb Setup (Codex CLI -- legacy notify)');
  log('  ' + '='.repeat(40) + '\n');
  log(`  Platform: ${process.platform}`);
  log(`  Home:     ${HOME}`);
  log(`  Adapter:  ${notifyPath}\n`);

  const read = readCodexConfig(configPath, log);
  if (read.error) {
    log(`  Add this line yourself: ${line}`);
    return { ok: false, modified: false, error: read.error };
  }
  log(read.existed ? '  [ok] Found existing Codex config' : '  [..] No existing config found');

  const keys = findNotifyKeys(read.body).filter(k => k.topLevel);
  let modified = false;
  if (keys.some(k => k.ours)) {
    log('  [ok] Code Crumb notify handler already configured');
  } else if (keys.length) {
    log('\n  [!!] Codex already has a notify handler configured.');
    log(`  To add Code Crumb, edit ${configPath}:`);
    log(`  ${line}`);
  } else {
    // At the top, so the key is at global scope (not under a [section]) --
    // but after a BOM, which must stay the first byte of the file.
    const eol = /\r\n/.test(read.body) ? '\r\n' : '\n';
    const block = `${NOTIFY_HEADER}${eol}${line}${eol}${eol}`;
    if (!writeCodexConfig(configPath, read.bom + block + read.body, read.existed ? read.text : null, log)) {
      log(`  [!!] Could not write ${configPath}`);
      return { ok: false, modified: false, error: new Error('write failed') };
    }
    modified = true;
    log(`  + Added notify handler to ${configPath}`);
  }

  if (opts.quiet) return { ok: true, modified };
  log(`
  ${'─'.repeat(42)}

  This is the LEGACY channel: \`notify\` fires once per turn,
  so the face can only show turn completions.

  NOTIFY MODE (basic -- turn-level events only):
     Configured above. Start the renderer:
       node "${rendererPath}"
     Then use Codex normally.

  Prefer one of these instead:

  HOOKS MODE (rich, interactive sessions too):
       node setup.js codex
     It takes this notify line out again: the two together
     report every turn twice.

  WRAPPER MODE (rich, headless \`codex exec\` runs):
       node "${wrapperPath}" "your prompt"
     This intercepts the JSONL stream for real-time
     tool-level face reactions.

  ${'─'.repeat(42)}
`);
  return { ok: true, modified };
}

// -- OpenCode Setup --------------------------------------------------
// OpenCode's config key is `plugin` (singular) and plugins are ESM modules
// loaded by its own Bun runtime, so Code Crumb ships the real plugin at
// adapters/opencode-plugin.mjs instead of asking anyone to paste a snippet.

const OPENCODE_SCHEMA = 'https://opencode.ai/config.json';

// Where OpenCode reads its global config: $XDG_CONFIG_HOME/opencode, else
// ~/.config/opencode -- on Windows too, where it resolves the directory with
// xdg-basedir off os.homedir(), not %APPDATA% (checked against the 1.18.21
// binary). OPENCODE_CONFIG_DIR names one more directory it reads
// opencode.json(c) from, after the global one; a user who set it keeps their
// config there, so setup writes there. Setup used to write ~/.config
// regardless and report success over a file OpenCode never read. In the
// directory, an existing opencode.jsonc is used when there is no
// opencode.json (OpenCode reads both). Resolved per call: tests pass an env.
function opencodeConfigDir(env = process.env) {
  if (env.OPENCODE_CONFIG_DIR) return path.resolve(env.OPENCODE_CONFIG_DIR);
  const base = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(HOME, '.config');
  return path.join(base, 'opencode');
}

function opencodeConfigPath(env = process.env) {
  const dir = opencodeConfigDir(env);
  const json = path.join(dir, 'opencode.json');
  const jsonc = path.join(dir, 'opencode.jsonc');
  return !fs.existsSync(json) && fs.existsSync(jsonc) ? jsonc : json;
}

const DEFAULT_OPENCODE_CONFIG = opencodeConfigPath();
const DEFAULT_OPENCODE_PLUGIN = path.resolve(__dirname, 'adapters', 'opencode-plugin.mjs').replace(/\\/g, '/');

// -- opencode.json is JSONC ------------------------------------------
// OpenCode reads it with // and /* */ comments and trailing commas allowed,
// and its own docs write it that way; setup refused such a file as "not
// valid JSON". A strict-JSON file keeps the old path (parsed, edited and
// written back with JSON.stringify -- there is nothing in it to lose).
// Anything else goes through blankJsonc, which turns every comment, then
// every trailing comma, into spaces of the same length: an offset into the
// blanked text is an offset into the user's own, so the edit is textual and
// minimal -- only the `plugin` member is rewritten (or added right after the
// opening brace) and every comment elsewhere survives. A comment INSIDE that
// member could not be kept through a rewrite, so setup refuses then and
// names the entry to add by hand. User config is never lost; the .bak rule
// still applies.

function skipJsonString(s, i) {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '"') return j + 1;
  }
  return s.length;
}

function skipBlank(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

function skipJsonValue(s, i) {
  if (s[i] === '"') return skipJsonString(s, i);
  if (s[i] === '{' || s[i] === '[') {
    let depth = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '"') { i = skipJsonString(s, i); continue; }
      if (c === '{' || c === '[') depth++;
      else if ((c === '}' || c === ']') && --depth === 0) return i + 1;
      i++;
    }
    return i;
  }
  while (i < s.length && !/[\s,\]}]/.test(s[i])) i++;
  return i;
}

// { noComments, clean, comments: [[start, end), ...] }, or null for an
// unterminated block comment.
function blankJsonc(text) {
  const out = text.split('');
  const comments = [];
  let i = 0;
  if (out[0] === '﻿') { out[0] = ' '; i = 1; }
  while (i < text.length) {
    if (text[i] === '"') { i = skipJsonString(text, i); continue; }
    if (text[i] === '/' && text[i + 1] === '/') {
      const start = i;
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') out[i++] = ' ';
      comments.push([start, i]);
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) return null;
      comments.push([i, close + 2]);
      for (; i < close + 2; i++) if (text[i] !== '\n' && text[i] !== '\r') out[i] = ' ';
      continue;
    }
    i++;
  }
  const noComments = out.join('');
  const clean = noComments.split('');
  for (let j = 0; j < noComments.length; j++) {
    if (noComments[j] === '"') { j = skipJsonString(noComments, j) - 1; continue; }
    if (noComments[j] !== ',') continue;
    const next = noComments[skipBlank(noComments, j + 1)];
    if (next === '}' || next === ']') clean[j] = ' ';
  }
  return { noComments, clean: clean.join(''), comments };
}

// The top-level object's `key` member in blanked text that already parsed:
// { open, empty, member: { keyStart, valueStart, valueEnd } | null }.
function findTopMember(s, key) {
  let i = skipBlank(s, 0);
  if (s[i] !== '{') return null;
  const open = i;
  i = skipBlank(s, i + 1);
  const empty = s[i] === '}';
  let member = null;
  while (i < s.length && s[i] !== '}') {
    if (s[i] === ',') { i = skipBlank(s, i + 1); continue; }
    const keyStart = i;
    const keyEnd = skipJsonString(s, i);
    let name;
    try { name = JSON.parse(s.slice(keyStart, keyEnd)); } catch { return null; }
    const valueStart = skipBlank(s, skipBlank(s, keyEnd) + 1);   // past the ':'
    const valueEnd = skipJsonValue(s, valueStart);
    if (name === key) member = { keyStart, valueStart, valueEnd };   // the last one wins, as in JSON.parse
    i = skipBlank(s, valueEnd);
  }
  return { open, empty, member };
}

// A plugin list as JSON text, in the shape the old one had: one line, or one
// entry per line under the key's own indentation.
function oneLineList(list) {
  return '[' + list.map(x => JSON.stringify(x)).join(', ') + ']';
}

function jsonList(list, raw, m) {
  const old = raw.slice(m.valueStart, m.valueEnd);
  if (!old.includes('\n') || !list.length) return oneLineList(list);
  const lineStart = raw.lastIndexOf('\n', m.keyStart - 1) + 1;
  const indent = /^[ \t]*/.exec(raw.slice(lineStart, m.keyStart))[0];
  const eol = old.includes('\r\n') ? '\r\n' : '\n';
  return '[' + eol + list.map(x => `${indent}  ${JSON.stringify(x)}`).join(',' + eol) + eol + indent + ']';
}

// The JSONC text with its `plugin` member set to `list` (null: removed), or
// null when a comment sits inside what would have to be rewritten.
function editJsoncPlugin(raw, blanked, list) {
  const top = findTopMember(blanked.clean, 'plugin');
  if (!top) return null;
  const commentIn = (a, b) => blanked.comments.some(([s, e]) => s < b && e > a);
  const m = top.member;
  if (m && list) {
    if (commentIn(m.valueStart, m.valueEnd)) return null;
    return raw.slice(0, m.valueStart) + jsonList(list, raw, m) + raw.slice(m.valueEnd);
  }
  if (m) {
    // The member and the comma after it -- and its whole line when nothing
    // else is on it, so no blank, indented line is left behind.
    let a = m.keyStart;
    let b = m.valueEnd;
    const k = skipBlank(blanked.noComments, b);
    if (blanked.noComments[k] === ',') b = k + 1;
    if (commentIn(a, b)) return null;
    const lineStart = raw.lastIndexOf('\n', a - 1) + 1;
    const nl = raw.indexOf('\n', b);
    const lineEnd = nl === -1 ? raw.length : nl;
    if (/^[ \t]*$/.test(raw.slice(lineStart, a)) && /^[ \t\r]*$/.test(raw.slice(b, lineEnd))) {
      a = lineStart;
      b = nl === -1 ? raw.length : nl + 1;
    }
    return raw.slice(0, a) + raw.slice(b);
  }
  if (!list) return raw;
  const member = `"plugin": ${oneLineList(list)}`;
  const at = top.open + 1;
  const nl = raw.indexOf('\n', at);
  if (nl !== -1 && blanked.noComments.slice(at, nl).trim() === '') {
    // `{` ends its line: the member goes on the next one, indented like the
    // members already there.
    const eol = raw[nl - 1] === '\r' ? '\r\n' : '\n';
    const indent = top.empty ? '  ' : (/^[ \t]*/.exec(raw.slice(nl + 1))[0] || '  ');
    return raw.slice(0, nl + 1) + indent + member + (top.empty ? '' : ',') + eol + raw.slice(nl + 1);
  }
  return raw.slice(0, at) + ' ' + member + (top.empty ? ' ' : ',') + raw.slice(at);
}

// readJsonConfig for opencode.json: strict JSON first, then JSONC. Same
// result shape, plus `jsonc` (blankJsonc's texts) when the file needed it.
function readOpenCodeConfig(filePath, log) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      log('  [..] No existing OpenCode config found, creating new');
      return { settings: {}, existed: false, raw: null, jsonc: null };
    }
    log(`  [!!] Could not read ${filePath}: ${err.message}`);
    log('       Leaving it untouched. Fix or move the file, then re-run setup.');
    return { error: err };
  }
  let settings;
  let jsonc = null;
  try {
    settings = JSON.parse(raw);
  } catch {
    jsonc = blankJsonc(raw);
    try {
      if (!jsonc) throw new Error('unterminated comment');
      settings = JSON.parse(jsonc.clean);
    } catch (err) {
      log(`  [!!] ${filePath} is not valid JSON or JSONC (${err.message}).`);
      log('       Leaving it untouched so nothing is lost. Fix the file, then re-run setup.');
      return { error: err };
    }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    log(`  [!!] ${filePath} is not a JSON object. Leaving it untouched.`);
    return { error: new Error('OpenCode config is not an object') };
  }
  log(`  [ok] Found existing OpenCode config${jsonc ? ' (JSONC -- its comments are kept)' : ''}`);
  return { settings, existed: true, raw, jsonc };
}

// writeSettings for text already serialized: .bak first, atomic, mode kept.
function writeConfigText(configPath, text, existed, raw, log) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let mode = 0o600;
  if (existed) {
    try { mode = fs.statSync(configPath).mode & 0o777; } catch {}
    if (writeBackup(configPath + '.bak', raw)) log(`  [ok] Backup written to ${configPath}.bak`);
  }
  const ok = writeJsonAtomic(configPath, text, mode || 0o600);
  if (!ok) log(`  [!!] Failed to write ${configPath}`);
  return ok;
}

// Write the plugin list back, in whichever form the file came in.
// Returns true, false (write failed) or 'comment' (refused, see above).
function writeOpenCodeConfig(configPath, read, list, log) {
  const { settings, existed, raw, jsonc } = read;
  if (!jsonc) {
    if (list && list.length) settings.plugin = list;
    else delete settings.plugin;
    return writeSettings(configPath, settings, existed, raw, log);
  }
  const text = editJsoncPlugin(raw, jsonc, list && list.length ? list : null);
  if (text === null) return 'comment';
  return writeConfigText(configPath, text, existed, raw, log);
}

// A config entry is `string` or `[string, options]`.
function pluginEntryPath(entry) {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0];
  return '';
}

// Our plugin at any path -- the repo may have moved since it was registered.
function isOurPlugin(entry) {
  return pluginEntryPath(entry).replace(/\\/g, '/').includes('adapters/opencode-plugin.mjs');
}

function printOpenCodeUsage(configPath, pluginPath, log) {
  const rendererPath = path.resolve(__dirname, 'renderer.js').replace(/\\/g, '/');
  const rule = '\u2500'.repeat(42);
  const arrow = '\u2192';
  log(`
  ${rule}

  Code Crumb ships the OpenCode plugin itself:
    ${pluginPath}

  1. Register it:
       node setup.js opencode --install
     or add it by hand to ${configPath}:
       {
         "$schema": "${OPENCODE_SCHEMA}",
         "plugin": ["${pluginPath}"]
       }
     The key is plugin, singular -- OpenCode ignores a plural one.

  2. Start the renderer:
       node "${rendererPath}"

  3. Use OpenCode normally -- the face reacts to every tool.

  Events handled:
    session.created      ${arrow} starting face
    reasoning parts      ${arrow} thinking face
    tool.execute.before  ${arrow} reading / editing / running / searching
    tool.execute.after   ${arrow} happy / satisfied / relieved
    a tool that throws   ${arrow} error face (after never fires for those)
    permission.asked     ${arrow} waiting, "allow?"
    permission.replied   ${arrow} satisfied
    question.asked       ${arrow} waiting, "asking you" (also plan_exit)
    question.replied     ${arrow} satisfied
    session.compacted    ${arrow} satisfied, "memory compacted"
    session.idle         ${arrow} happy, turn over
    session.error        ${arrow} error face, turn over (an Esc: interrupted;
                           a context overflow: compacting memory)

  Upgrading: if you still have a hand-written
  ~/.config/opencode/plugins/code-crumb.js, delete it and remove its config
  entry. It targets an API OpenCode no longer has, so its session ids never
  arrive and its tool input is always empty.

  The plugin runs under Bun and spawns node for the adapter. If node is not
  on PATH there, set CODE_CRUMB_NODE to its full path.

  To remove the plugin entry again:
    node setup.js opencode --uninstall

  ${rule}
`);
}

// Register the plugin in opencode.json (with --install), or just print the
// instructions. opts: { configPath, pluginPath, install, log, quiet }
// Returns { ok, modified, added, replaced, error? }.
function setupOpenCode(opts = {}) {
  const configPath = opts.configPath || opencodeConfigPath();
  const pluginPath = opts.pluginPath || DEFAULT_OPENCODE_PLUGIN;
  const log = opts.log || console.log;
  const install = !!opts.install;

  log('\n  Code Crumb Setup (OpenCode)');
  log('  ' + '='.repeat(40) + '\n');
  log(`  Platform: ${process.platform}`);
  log(`  Home:     ${HOME}`);
  log(`  Plugin:   ${pluginPath}`);
  log(`  Config:   ${configPath}\n`);

  if (!install) {
    log('  Nothing written (pass --install to register the plugin).');
    if (!opts.quiet) printOpenCodeUsage(configPath, pluginPath, log);
    return { ok: true, modified: false, added: 0, replaced: 0 };
  }

  const read = readOpenCodeConfig(configPath, log);
  if (read.error) return { ok: false, modified: false, added: 0, replaced: 0, error: read.error };
  const config = read.settings;

  // (OpenCode writes a missing $schema into the file itself; a JSONC file is
  // edited only where the plugin list is.)
  if (!read.jsonc && !config.$schema) config.$schema = OPENCODE_SCHEMA;
  let list = Array.isArray(config.plugin) ? config.plugin.slice() : [];
  if (config.plugins) {
    log('  [!!] Found a plural plugins key. OpenCode reads plugin (singular);');
    log('       the plural one does nothing. Leaving it in place.');
  }

  let added = 0;
  let replaced = 0;
  if (list.some(e => pluginEntryPath(e) === pluginPath)) {
    log('  [ok] Plugin already registered');
  } else if (list.some(isOurPlugin)) {
    // A Code Crumb entry at a different path: the repo moved.
    list = list.filter(e => !isOurPlugin(e)).concat(pluginPath);
    replaced = 1;
    log('  ~ Updated the plugin path');
  } else {
    list.push(pluginPath);
    added = 1;
    log('  + Registered the Code Crumb plugin');
  }

  const legacy = list.filter(e => !isOurPlugin(e) && /code-crumb/i.test(pluginEntryPath(e)));
  for (const entry of legacy) {
    log(`  [!!] Old hand-written entry still listed: ${pluginEntryPath(entry)}`);
    log('       Remove it -- two plugins means every event fires twice.');
  }

  const modified = added + replaced > 0;
  if (modified) {
    const wrote = writeOpenCodeConfig(configPath, read, list, log);
    if (wrote === 'comment') {
      log(`  [!!] ${configPath} has a comment inside its plugin list, which a rewrite would lose.`);
      log('       Leaving the file untouched. Add this entry to the list yourself:');
      log(`         "${pluginPath}"`);
      return { ok: false, modified: false, added, replaced, error: new Error('comment in the plugin list') };
    }
    if (!wrote) {
      return { ok: false, modified: false, added, replaced, error: new Error('write failed') };
    }
    log(`\n  Plugin registered in ${configPath}`);
  } else {
    log('\n  Config already up to date');
  }

  if (!opts.quiet) printOpenCodeUsage(configPath, pluginPath, log);
  return { ok: true, modified, added, replaced };
}

// Remove every Code Crumb plugin entry (any path) and drop the key if it
// ends up empty. opts: { configPath, log }. Returns { ok, removed, error? }.
function uninstallOpenCode(opts = {}) {
  const configPath = opts.configPath || opencodeConfigPath();
  const log = opts.log || console.log;

  log('\n  Code Crumb Uninstall (OpenCode)');
  log('  ' + '='.repeat(40) + '\n');

  const read = readOpenCodeConfig(configPath, log);
  if (read.error) return { ok: false, removed: 0, error: read.error };
  const config = read.settings;

  let removed = 0;
  let kept = [];
  if (Array.isArray(config.plugin)) {
    kept = config.plugin.filter(e => !isOurPlugin(e));
    removed = config.plugin.length - kept.length;
  }

  if (removed === 0) {
    log('  [ok] No Code Crumb plugin entry found -- nothing to do');
    return { ok: true, removed: 0 };
  }
  const wrote = writeOpenCodeConfig(configPath, read, kept, log);
  if (wrote === 'comment') {
    log(`  [!!] ${configPath} has a comment inside its plugin list, which a rewrite would lose.`);
    log('       Leaving the file untouched. Remove the opencode-plugin.mjs entry yourself.');
    return { ok: false, removed: 0, error: new Error('comment in the plugin list') };
  }
  if (!wrote) {
    return { ok: false, removed: 0, error: new Error('write failed') };
  }
  log(`  - Removed ${removed} Code Crumb plugin entry from ${configPath}\n`);
  return { ok: true, removed };
}

// -- OpenClaw / Pi Setup ---------------------------------------------

function setupOpenClaw() {
  const adapterPath = path.resolve(__dirname, 'adapters', 'openclaw-adapter.js').replace(/\\/g, '/');
  const rendererPath = path.resolve(__dirname, 'renderer.js').replace(/\\/g, '/');

  console.log('\n  Code Crumb Setup (OpenClaw / Pi)');
  console.log('  ' + '='.repeat(40) + '\n');
  console.log(`  Platform: ${process.platform}`);
  console.log(`  Home:     ${HOME}`);
  console.log(`  Adapter:  ${adapterPath}\n`);

  console.log(`
  ${'─'.repeat(42)}

  OpenClaw uses the Pi coding agent engine, which
  has an extension system with tool lifecycle events.

  OPTION 1: Pi Extension (recommended)
  ${'─'.repeat(38)}

  Create a Pi extension that pipes events to the adapter.
  Add this to your OpenClaw workspace or ~/.openclaw/extensions/:

    // code-crumb-extension.js
    module.exports = function(pi) {
      const { execFileSync } = require('child_process');
      const adapter = '${adapterPath}';
      // One id for this Pi process. Without it every event fell back to the
      // adapter's parent pid -- a fresh shell per event -- and each tool call
      // became a session of its own.
      const session_id = \`openclaw-\${process.pid}\`;

      function send(payload) {
        try {
          execFileSync('node', [adapter],
            { input: JSON.stringify({ ...payload, session_id }),
              timeout: 2000, stdio: ['pipe','ignore','ignore'] });
        } catch {}
      }

      pi.on('tool_call', (event) => {
        send({ event: 'tool_call', toolName: event.toolName,
               input: event.input });
      });

      pi.on('tool_result', (event) => {
        send({ event: 'tool_result', toolName: event.toolName,
               input: event.input, output: event.result || '',
               error: event.error || false });
      });
    };

  OPTION 2: Standalone adapter (pipe JSON)
  ${'─'.repeat(38)}

  Pipe events from any script or tool:

    echo '{"event":"tool_call","toolName":"edit","input":{"file_path":"src/app.ts"}}' | \\
      node "${adapterPath}"

  Pi-native event types:
    tool_call             → face shows activity state
    tool_execution_start  → face shows activity state
    tool_execution_end    → face shows outcome state
    tool_result           → face shows outcome state

  Generic event types (also accepted):
    tool_start, tool_end, turn_end, error, waiting

  To start the renderer:
    node "${rendererPath}"

  ${'─'.repeat(42)}
`);
}

// -- Autolaunch preference -------------------------------------------

// Enabling autolaunch also clears the renderer's quit flag: the renderer
// writes it on every exit, and while it exists no hook launches anything --
// so the promise printed below was otherwise broken for anyone who had ever
// closed a renderer window.
function enableAutolaunch(log = console.log, quitFlagFile = QUIT_FLAG_FILE) {
  savePrefs({ autolaunch: true });
  try { fs.unlinkSync(quitFlagFile); } catch {}
  log('  [ok] Autolaunch enabled -- the renderer will start automatically on the first hook call');
}

// Only the hook-based integrations (update-state.js) launch the renderer; the
// adapters never do, so setup must not offer or promise autolaunch for them.
const AUTOLAUNCH_COMMANDS = new Set(['claude', 'claude-code', 'codex', 'openai']);

// -- Doctor ----------------------------------------------------------
// `node setup.js doctor` answers "why does the face show nothing?" by
// checking everything the hooks and the renderer depend on: node, the
// renderer's heartbeat, the Claude Code hooks (manual, plugin, or both), the
// Codex hooks, autolaunch, and when a hook last wrote anything. One line per
// check -- a tick when it is fine, a `!` plus a suggested fix when it is
// not, a dot for plain information.
//
// It is READ-ONLY: no backup, no prefs, no quit-flag cleanup, no repair --
// only reads, stats and the kill(pid, 0) probe isRendererAlive makes. And it
// never throws: a missing, unreadable or garbage file is itself a finding.
// The plugin is found through installed_plugins.json, the file
// `claude plugin list --json` reports from, so nothing is spawned (claude
// takes seconds to start and need not be on PATH). Returns { problems };
// the CLI exits 1 when any `!` was printed.
//
// opts: { home, env, log, now, nodeVersion } -- every path is derived from
// `home` and `env` the way shared.js and setup.js derive them, so a test
// can point it at a temp home.

const { PID_FILE, PREFS_FILE, SESSIONS_DIR, isRendererAlive } = require('./lib/shared');

const DOCTOR_OK = '\u2713';
const DOCTOR_BAD = '!';
const DOCTOR_INFO = '\u00b7';
// No write for this long and the question is "are the hooks firing at all?"
const DOCTOR_QUIET_MS = 60 * 60 * 1000;

function doctorIsObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Read and parse a JSON file. { exists, data } or { exists, error }.
function doctorReadJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { exists: false };
    return { exists: true, error: (e && (e.code || e.message)) || 'unreadable' };
  }
  try {
    return { exists: true, data: JSON.parse(raw.replace(/^\uFEFF/, '')) };
  } catch {
    return { exists: true, error: 'not valid JSON' };
  }
}

function doctorReadText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function doctorStat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function doctorAge(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 48 * 3600) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Numeric x.y.z comparison; anything unparseable (a git sha) compares equal,
// so it can never raise a false "out of date".
function doctorCompareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10));
  const pb = String(b).split('.').map(n => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(pa[i]) || !Number.isFinite(pb[i])) return 0;
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// Windows env keys are case-insensitive (Path, PATH), a plain object's are not.
function doctorEnv(env, name) {
  const key = Object.keys(env).find(k => k.toUpperCase() === name);
  return key ? String(env[key] || '') : '';
}

function doctorFindOnPath(name, env) {
  const exts = process.platform === 'win32'
    ? (doctorEnv(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).concat([''])
    : [''];
  for (const dir of doctorEnv(env, 'PATH').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      const st = doctorStat(candidate);
      if (st && st.isFile()) return candidate;
    }
  }
  return '';
}

// Every Code Crumb command in a { hooks: { Event: [group...] } } config.
function doctorOurCommands(config) {
  const out = [];
  const hooks = doctorIsObject(config) && doctorIsObject(config.hooks) ? config.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const hh of group.hooks) {
        if (isOurCommand(hh)) out.push({ event, command: hh.command });
      }
    }
  }
  return out;
}

// The update-state.js a hook command runs, as a checkable path -- or '' when
// it cannot be checked from here (a $VAR the shell would expand).
function doctorScriptPath(command, home) {
  const m = /(["'])([^"']*update-state\.js)\1/.exec(command) || /(\S*update-state\.js)/.exec(command);
  let p = m ? (m[2] || m[1]) : '';
  if (!p || p.includes('$')) return '';
  if (p.startsWith('~/')) p = path.join(home, p.slice(2));
  // Git Bash spells C:/x as /c/x; fs on Windows does not.
  if (process.platform === 'win32') p = p.replace(/^\/([a-zA-Z])\//, '$1:/');
  return p;
}

// Which hook scripts a set of commands runs, and which of those are gone.
function doctorScripts(commands, home) {
  const scripts = [...new Set(commands.map(c => doctorScriptPath(c.command, home)).filter(Boolean))];
  return { scripts, missing: scripts.filter(p => !doctorStat(p)) };
}

// Code Crumb's entries in installed_plugins.json (version 2:
// { plugins: { "code-crumb@<marketplace>": [{ scope, installPath, version }] } }).
function doctorPluginInstalls(data) {
  const out = [];
  const plugins = doctorIsObject(data) && doctorIsObject(data.plugins) ? data.plugins : {};
  for (const [key, list] of Object.entries(plugins)) {
    if (!/^code-crumb@/.test(key) || !Array.isArray(list)) continue;
    for (const entry of list) {
      if (!doctorIsObject(entry) || typeof entry.installPath !== 'string') continue;
      out.push({
        key,
        scope: typeof entry.scope === 'string' ? entry.scope : '',
        installPath: entry.installPath,
        version: typeof entry.version === 'string' ? entry.version : '',
      });
    }
  }
  return out;
}

function doctor(opts = {}) {
  const home = opts.home || HOME;
  const env = opts.env || process.env;
  const log = opts.log || console.log;
  const now = opts.now || Date.now();
  const nodeVersion = String(opts.nodeVersion || process.versions.node);

  let problems = 0;
  const ok = (msg) => log(`  ${DOCTOR_OK} ${msg}`);
  const info = (msg) => log(`  ${DOCTOR_INFO} ${msg}`);
  const note = (msg) => log(`      ${msg}`);
  // `fix` is one line or several (a command each).
  const bad = (msg, fix) => {
    problems++;
    log(`  ${DOCTOR_BAD} ${msg}`);
    [].concat(fix || []).forEach((line, i) => note(`${i ? '     ' : 'fix: '}${line}`));
  };
  // One check failing in a way nobody foresaw must not hide the others.
  const check = (name, fn) => {
    try { fn(); } catch (e) { bad(`could not check ${name}: ${(e && e.message) || e}`); }
  };

  const fwd = p => String(p).replace(/\\/g, '/');
  const pidFile = path.join(home, path.basename(PID_FILE));
  const quitFile = path.join(home, path.basename(QUIT_FLAG_FILE));
  const prefsFile = path.join(home, path.basename(PREFS_FILE));
  const sessionsDir = path.join(home, path.basename(SESSIONS_DIR));
  const stateFile = env.CODE_CRUMB_STATE || path.join(home, '.code-crumb-state');
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  const codexHooksPath = path.join(codexHome, 'hooks.json');
  const codexConfigPath = path.join(codexHome, 'config.toml');
  const opencodePath = path.join(home, '.config', 'opencode', 'opencode.json');
  const ownRenderer = fwd(path.resolve(__dirname, 'renderer.js'));
  const ownSetup = fwd(path.resolve(__dirname, 'setup.js'));
  const pkg = doctorReadJson(path.join(__dirname, 'package.json'));
  const ownVersion = doctorIsObject(pkg.data) && typeof pkg.data.version === 'string' ? pkg.data.version : '';

  log('\n  Code Crumb Doctor (read-only)');
  log('  ' + '='.repeat(40) + '\n');
  info(`this copy: ${fwd(__dirname)}${ownVersion ? ` (v${ownVersion})` : ''}`);
  info(`home:      ${home}`);
  log('');

  // Gathered first and printed in reading order below: the renderer's fix
  // names the plugin's renderer when that is what the hooks run, and the
  // last-hook line wants to know whether anything is installed at all.
  let prefs = {};
  let prefsError = '';
  const prefsRead = doctorReadJson(prefsFile);
  if (prefsRead.error) prefsError = prefsRead.error;
  else if (prefsRead.exists && !doctorIsObject(prefsRead.data)) prefsError = 'not a JSON object';
  else if (prefsRead.exists) prefs = prefsRead.data;
  const autolaunch = !!prefs.autolaunch;
  const quitStat = doctorStat(quitFile);
  const pidStat = doctorStat(pidFile);
  let rendererAlive = false;
  try { rendererAlive = !!pidStat && isRendererAlive(pidFile, now); } catch {}

  const settingsRead = doctorReadJson(settingsPath);
  const settings = doctorIsObject(settingsRead.data) ? settingsRead.data : {};
  const manual = doctorOurCommands(settings);
  const enabledKeys = doctorIsObject(settings.enabledPlugins)
    ? Object.keys(settings.enabledPlugins).filter(k => /^code-crumb@/.test(k) && settings.enabledPlugins[k])
    : [];
  const installsRead = doctorReadJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
  const installs = doctorPluginInstalls(installsRead.data);
  const pluginInstall = enabledKeys.length
    ? (installs.find(i => i.key === enabledKeys[0] && i.scope === 'user') || installs.find(i => i.key === enabledKeys[0]))
    : null;
  const pluginLive = !!(pluginInstall && doctorStat(path.join(pluginInstall.installPath, 'update-state.js')));
  const pluginRenderer = pluginLive ? fwd(path.join(pluginInstall.installPath, 'renderer.js')) : '';
  const rendererCmd = `node "${manual.length || !pluginRenderer ? ownRenderer : pluginRenderer}"`;
  const setupCmd = `node "${manual.length || !pluginLive ? ownSetup : fwd(path.join(pluginInstall.installPath, 'setup.js'))}"`;

  const codexRead = doctorReadJson(codexHooksPath);
  const codex = doctorOurCommands(codexRead.data);
  const notifyLine = /^\s*notify\s*=.*codex-notify\.js/m.test(doctorReadText(codexConfigPath));

  const opencodeRead = doctorReadJson(opencodePath);
  const opencodeEntries = doctorIsObject(opencodeRead.data) && Array.isArray(opencodeRead.data.plugin)
    ? opencodeRead.data.plugin.filter(isOurPlugin).map(pluginEntryPath)
    : [];

  // -- node --
  check('node', () => {
    const major = parseInt(nodeVersion.replace(/^v/, ''), 10);
    if (major >= 18) ok(`node v${nodeVersion.replace(/^v/, '')} (18+ needed)`);
    else bad(`node v${nodeVersion.replace(/^v/, '')} is too old -- Code Crumb needs 18+`, 'install Node.js 18 or newer from https://nodejs.org');
    const onPath = doctorFindOnPath('node', env);
    if (onPath) ok(`node is on PATH (${onPath}) -- every hook runs \`node\``);
    else bad('node is not on PATH -- every hook runs `node ...`, so every hook fails', 'install Node.js, or put its folder on PATH (Claude Code on Windows runs hooks through Git Bash, so that PATH needs it too)');
  });

  // -- renderer --
  check('the renderer', () => {
    const pidText = pidStat ? doctorReadText(pidFile).trim() : '';
    const age = pidStat ? doctorAge(now - pidStat.mtimeMs) : '';
    if (rendererAlive) {
      ok(`renderer running (pid ${pidText}, last heartbeat ${age} ago)`);
    } else if (autolaunch && !quitStat) {
      ok('renderer not running -- autolaunch opens it on the next hook');
    } else {
      const why = pidStat ? ` (its PID file, pid ${pidText || '?'}, last beat ${age} ago)` : '';
      bad(`renderer is not running${why}`, [
        'start it in a terminal of its own:',
        `  ${rendererCmd}`,
        'or let the hooks open it from now on:',
        `  ${setupCmd} --autolaunch`,
      ]);
    }
  });

  // -- Claude Code --
  check('the Claude Code hooks', () => {
    if (settingsRead.error || (settingsRead.exists && !doctorIsObject(settingsRead.data))) {
      bad(`${settingsPath} is ${settingsRead.error || 'not a JSON object'} -- Claude Code loads no hooks from it`,
        'fix the file by hand; node setup.js will not touch it until it parses');
    }
    if (manual.length) {
      const byEvent = new Map();
      for (const c of manual) byEvent.set(c.event, (byEvent.get(c.event) || 0) + 1);
      const missing = HOOK_EVENTS.filter(e => !byEvent.has(e));
      const dupes = [...byEvent].filter(([, n]) => n > 1).map(([e]) => e);
      const { scripts, missing: gone } = doctorScripts(manual, home);
      for (const p of gone) {
        bad(`manual hooks run ${p}, which does not exist -- every one of them fails (a moved or deleted clone)`,
          ['re-run setup from wherever the clone lives now; it rewrites the paths. For this copy:', `  node "${ownSetup}"`]);
      }
      if (missing.length) {
        bad(`manual hooks miss ${missing.length} of ${HOOK_EVENTS.length} events: ${missing.join(', ')}`,
          'npm run setup (or node setup.js) registers the rest');
      }
      if (dupes.length) {
        bad(`manual hooks register ${dupes.join(', ')} more than once -- each of those events fires twice`,
          'node setup.js uninstall, then node setup.js');
      }
      if (!gone.length && !missing.length && !dupes.length) {
        ok(`Claude Code: manual hooks for all ${HOOK_EVENTS.length} events in ${settingsPath}`);
      }
      for (const p of scripts) {
        if (p !== DEFAULT_HOOK_PATH && !gone.includes(p)) note(`they run ${p} (this copy is ${DEFAULT_HOOK_PATH})`);
      }
    }
    if (enabledKeys.length > 1) {
      bad(`${enabledKeys.join(' and ')} are all enabled -- every event fires ${enabledKeys.length} times`,
        `keep one: claude plugin uninstall ${enabledKeys.slice(1).join(' / ')}`);
    }
    if (enabledKeys.length) {
      const key = enabledKeys[0];
      if (!pluginInstall) {
        const why = installsRead.error ? ` (${path.join(claudeDir, 'plugins', 'installed_plugins.json')} is ${installsRead.error})` : '';
        bad(`plugin ${key} is enabled in settings.json but not installed${why}`, `claude plugin install ${key}`);
      } else if (!pluginLive) {
        bad(`plugin ${key} is installed at ${pluginInstall.installPath}, which has no update-state.js`,
          `claude plugin uninstall ${key}, then claude plugin install ${key}`);
      } else {
        ok(`Claude Code: plugin ${key}${pluginInstall.version ? ` v${pluginInstall.version}` : ''}`);
        note(`installed at ${pluginInstall.installPath}`);
        note(`start the face: node "${pluginRenderer}"`);
        const samePlace = path.resolve(pluginInstall.installPath) === path.resolve(__dirname);
        if (!samePlace && ownVersion && pluginInstall.version &&
            doctorCompareVersions(pluginInstall.version, ownVersion) < 0) {
          bad(`the plugin is still v${pluginInstall.version}; this copy is v${ownVersion}`,
            `claude plugin marketplace update ${key.split('@')[1]}, then claude plugin update ${key}, then restart Claude Code`);
        }
      }
      if (manual.length) {
        bad('the plugin AND the manual hooks are installed -- every event fires twice and the counters double',
          `keep one: node setup.js uninstall (drops the manual hooks) or claude plugin uninstall ${key}`);
      }
    } else if (installs.length) {
      info(`plugin ${installs[0].key} is installed but disabled (claude plugin enable ${installs[0].key})`);
    }
  });

  // -- Codex --
  check('the Codex hooks', () => {
    if (codexRead.error || (codexRead.exists && !doctorIsObject(codexRead.data))) {
      bad(`${codexHooksPath} is ${codexRead.error || 'not a JSON object'} -- Codex runs none of its hooks`,
        'fix it by hand, or move it aside and run npm run setup:codex');
    }
    if (codex.length) {
      const events = new Set(codex.map(c => c.event));
      const untagged = codex.filter(c => !/--editor[=\s]+codex(\s|$)/.test(c.command));
      const missing = CODEX_HOOK_EVENTS.filter(e => !events.has(e));
      const extra = [...events].filter(e => !CODEX_HOOK_EVENTS.includes(e));
      const { missing: gone } = doctorScripts(codex, home);
      for (const p of gone) {
        bad(`Codex hooks run ${p}, which does not exist -- every one of them fails`,
          'run npm run setup:codex from wherever the clone lives now');
      }
      if (untagged.length) {
        bad(`${untagged.length} of ${codex.length} Codex hooks have no --editor codex tag -- sessions show as "claude" and every codex exec wrapper run is counted twice`,
          'npm run setup:codex (rewrites them)');
      }
      if (missing.length) {
        bad(`Codex hooks miss ${missing.join(', ')}`, 'npm run setup:codex registers the rest');
      }
      if (!gone.length && !untagged.length && !missing.length) {
        ok(`Codex: ${CODEX_HOOK_EVENTS.length} hooks in ${codexHooksPath}, tagged --editor codex`);
      }
      if (extra.length) note(`also registered for ${extra.join(', ')}, which codex never fires (npm run setup:codex prunes them)`);
      note('Codex asks once to trust new hooks and runs none of them until you say yes');
      if (notifyLine) {
        bad(`${codexConfigPath} still has the legacy codex-notify line as well -- every Codex turn end is reported twice`,
          `delete the notify = [... codex-notify.js] line from ${codexConfigPath}`);
      }
    } else if (notifyLine) {
      info(`Codex: legacy notify channel only (turn ends, no tool events) -- npm run setup:codex, then drop the notify line from ${codexConfigPath}`);
    } else {
      info('Codex: not set up (npm run setup:codex if you use it)');
    }
  });

  // -- OpenCode (shown only when registered) --
  check('the OpenCode plugin', () => {
    for (const entry of opencodeEntries) {
      if (doctorStat(entry)) ok(`OpenCode: plugin registered in ${opencodePath}`);
      else bad(`OpenCode: ${opencodePath} registers ${entry}, which does not exist`, 'node setup.js opencode --install from wherever the clone lives now');
    }
  });

  if (!manual.length && !enabledKeys.length && !codex.length && !notifyLine && !opencodeEntries.length) {
    bad('no editor integration found -- nothing will ever write to the face',
      'npm run setup (Claude Code), npm run setup:codex, or install the plugin (see the README)');
  } else if (!manual.length && !enabledKeys.length) {
    info('Claude Code: not set up (npm run setup, or install the plugin)');
  }

  // -- autolaunch --
  check('autolaunch', () => {
    if (prefsError) {
      bad(`${prefsFile} is ${prefsError} -- every preference reads as its default, autolaunch included`,
        ['rewrite it with autolaunch on (the other prefs reset to their defaults):', `  ${setupCmd} --autolaunch`]);
    }
    if (!autolaunch) {
      info(`autolaunch off -- start the renderer yourself, or turn it on: ${setupCmd} --autolaunch`);
    } else if (quitStat && !rendererAlive) {
      bad(`autolaunch is on, but the quit flag the renderer left ${doctorAge(now - quitStat.mtimeMs)} ago (${quitFile}) holds it off until your editor starts a new session`,
        ['start a new session (claude, claude --continue), or clear it now:', `  ${setupCmd} --autolaunch`]);
    } else {
      ok('autolaunch on');
    }
  });

  // -- last hook --
  check('the last hook', () => {
    let newest = null;
    const consider = (file) => {
      const st = doctorStat(file);
      if (st && st.isFile() && (!newest || st.mtimeMs > newest.mtimeMs)) newest = { file, mtimeMs: st.mtimeMs };
    };
    consider(stateFile);
    let names = [];
    try { names = fs.readdirSync(sessionsDir); } catch {}
    for (const n of names) if (n.endsWith('.json')) consider(path.join(sessionsDir, n));
    const fix = 'use your editor once, then run this again; inside Claude Code, /hooks lists what is registered and claude --debug shows hook errors';
    if (!newest) {
      bad('no hook has written anything yet -- are the hooks installed and firing?', fix);
    } else if (now - newest.mtimeMs > DOCTOR_QUIET_MS) {
      bad(`no hook has written in ${doctorAge(now - newest.mtimeMs)} -- are the hooks firing?`, fix);
    } else {
      ok(`last hook ${doctorAge(now - newest.mtimeMs)} ago (${path.basename(newest.file)})`);
    }
  });

  log('');
  log(problems
    ? `  ${problems} problem${problems === 1 ? '' : 's'} found.\n`
    : '  No problems found.\n');
  return { problems };
}

// -- CLI -------------------------------------------------------------

function printUsage() {
  console.log('  Supported editors: claude, codex, codex-notify, opencode, openclaw');
  console.log('  Usage: node setup.js [claude|codex|codex-notify|opencode|openclaw|uninstall] [--autolaunch]');
  console.log('         node setup.js opencode [--install|--uninstall]');
  console.log('         node setup.js doctor   (read-only health check; exits 1 if it finds a problem)\n');
}

const KNOWN_FLAGS = new Set(['--autolaunch', '--install', '--uninstall', '--help']);

function main() {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs.filter(a => !a.startsWith('-'));
  const flags = rawArgs.filter(a => a.startsWith('-'));
  const autolaunchFlag = flags.includes('--autolaunch');
  const command = (args[0] || '').toLowerCase();

  // A flag setup does not know used to be dropped silently, so the command
  // fell through to the default Claude install: `--help` installed 22 hooks
  // and `codex --uninstall` INSTALLED the Codex hooks.
  if (flags.includes('--help') || flags.includes('-h')) {
    printUsage();
    return;
  }
  const unknown = flags.filter(f => !KNOWN_FLAGS.has(f));
  if (unknown.length) {
    console.log(`\n  Unknown option: ${unknown.join(' ')}`);
    printUsage();
    process.exit(1);
  }
  if ((flags.includes('--install') || flags.includes('--uninstall')) && command !== 'opencode') {
    console.log('\n  --install / --uninstall only apply to `opencode`.');
    console.log('  To remove the Claude Code and Codex hooks: node setup.js uninstall');
    printUsage();
    process.exit(1);
  }

  // `node setup.js --autolaunch` on its own only flips the preference; it
  // used to silently re-run the whole Claude Code hook install as well.
  if (!command && autolaunchFlag) {
    enableAutolaunch();
    return;
  }

  switch (command || 'claude') {
    case 'claude':
    case 'claude-code': {
      const r = setupClaude();
      if (!r.ok) process.exit(1);
      break;
    }
    case 'uninstall': {
      const r = uninstallClaude();
      // Codex hooks live in their own file; clean them up too if present,
      // and the legacy notify line in config.toml with them.
      let codexOk = true;
      if (fs.existsSync(DEFAULT_CODEX_HOOKS_PATH)) {
        codexOk = uninstallCodex().ok;
      }
      const codexConfig = path.join(codexHome(), 'config.toml');
      if (fs.existsSync(codexConfig)) {
        codexOk = removeCodexNotify({ configPath: codexConfig }).ok && codexOk;
      }
      process.exit(r.ok && codexOk ? 0 : 1);
      break;
    }
    case 'codex':
    case 'openai': {
      const r = setupCodex();
      if (!r.ok) process.exit(1);
      break;
    }
    case 'codex-notify':
    case 'notify': {
      const r = setupCodexNotify();
      if (!r.ok) process.exit(1);
      break;
    }
    case 'opencode': {
      if (flags.includes('--uninstall')) {
        const r = uninstallOpenCode();
        process.exit(r.ok ? 0 : 1);
      }
      const r = setupOpenCode({ install: flags.includes('--install') });
      if (!r.ok) process.exit(1);
      break;
    }
    case 'openclaw':
    case 'claw':
    case 'pi':
      setupOpenClaw();
      break;
    case 'doctor':
      // Read-only, so it also skips the autolaunch question below.
      process.exit(doctor().problems ? 1 : 0);
      break;
    default:
      console.log(`\n  Unknown editor: "${command}"`);
      printUsage();
      process.exit(1);
  }

  if (!AUTOLAUNCH_COMMANDS.has(command || 'claude')) {
    if (autolaunchFlag) {
      console.log('  [!!] --autolaunch only works with the Claude Code and Codex hooks;');
      console.log(`       ${command} events never start the renderer -- run it yourself.`);
    }
  } else if (autolaunchFlag) {
    enableAutolaunch();
  } else if (process.stdout.isTTY && process.stdin.isTTY) {
    // Interactive prompt
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('  Auto-launch renderer when your editor starts? [y/N] ', (answer) => {
      if (answer.trim().toLowerCase() === 'y') {
        enableAutolaunch();
      } else {
        console.log('  Autolaunch skipped (enable later with: node setup.js --autolaunch)');
      }
      rl.close();
    });
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  setupClaude,
  printClaudeUsage,
  uninstallClaude,
  setupOpenCode,
  uninstallOpenCode,
  opencodeConfigDir,
  opencodeConfigPath,
  buildFaceHooks,
  setupCodex,
  uninstallCodex,
  buildCodexHooks,
  setupCodexNotify,
  removeCodexNotify,
  codexHome,
  enableAutolaunch,
  HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  DEFAULT_HOOK_PATH,
  DEFAULT_SETTINGS_PATH,
  DEFAULT_CODEX_HOOKS_PATH,
  DEFAULT_OPENCODE_CONFIG,
  DEFAULT_OPENCODE_PLUGIN,
};

// The read-only diagnostic behind `node setup.js doctor`.
module.exports.doctor = doctor;
