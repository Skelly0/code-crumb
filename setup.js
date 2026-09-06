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
// |    node setup.js opencode     (OpenCode)                       |
// |    node setup.js openclaw     (OpenClaw / Pi)                  |
// |    node setup.js --autolaunch (only flip the autolaunch pref)  |
// |                                                                |
// |  The Claude Code and Codex installers are also modules:        |
// |  setupClaude() / uninstallClaude() / setupCodex() /            |
// |  uninstallCodex() take { settingsPath | hooksPath, log } so    |
// |  tests never touch a real settings.json or hooks.json.         |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { HOME, savePrefs, writeJsonAtomic } = require('./shared');

const HOOK_SCRIPT = path.resolve(__dirname, 'update-state.js');

// Normalise to forward slashes -- works in Node on all platforms
// and avoids JSON escaping nightmares with backslashes
const DEFAULT_HOOK_PATH = HOOK_SCRIPT.replace(/\\/g, '/');
const DEFAULT_SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');

const DEFAULT_CODEX_HOOKS_PATH = path.join(HOME, '.codex', 'hooks.json');

const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop',
  'Notification', 'SubagentStart', 'SubagentStop',
  'TeammateIdle', 'TaskCompleted', 'SessionStart', 'SessionEnd',
  'PreCompact', 'PostCompact', 'PermissionRequest', 'Setup',
  'Elicitation', 'ElicitationResult', 'ConfigChange',
  'InstructionsLoaded', 'StopFailure', 'UserPromptSubmit',
];

// Codex 0.146 fires a subset of the same event names (no Notification, no
// PostToolUseFailure). Registering an event codex does not know about only
// leaves dead config behind, so this list is exactly its supported set.
const CODEX_HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PermissionRequest', 'PreCompact',
  'SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop',
  'UserPromptSubmit', 'Stop',
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
        }],
      },
    ];
  }
  return faceHooks;
}

// Any hook entry that points at an update-state.js (ours, at any path).
function isOurHook(entry) {
  return !!entry?.hooks?.some(hh => typeof hh?.command === 'string' && /update-state\.js/.test(hh.command));
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

// Read settings.json. A missing file means "start fresh"; anything else that
// goes wrong (unreadable, invalid JSON, not an object) means "do not touch
// it" -- the old behaviour silently replaced a broken settings.json with just
// our hooks, wiping permissions, env, MCP servers and everything else.
function readSettings(settingsPath, log, label = 'Claude settings') {
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      log('  [..] No existing settings found, creating new');
      return { settings: {}, existed: false, raw: null };
    }
    log(`  [!!] Could not read ${settingsPath}: ${err.message}`);
    log('       Leaving it untouched. Fix or move the file, then re-run setup.');
    return { error: err };
  }
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch (err) {
    log(`  [!!] ${settingsPath} is not valid JSON (${err.message}).`);
    log('       Leaving it untouched so nothing is lost. Fix the file, then re-run setup.');
    return { error: err };
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    log(`  [!!] ${settingsPath} is not a JSON object. Leaving it untouched.`);
    return { error: new Error('settings.json is not an object') };
  }
  log(`  [ok] Found existing ${label}`);
  return { settings, existed: true, raw };
}

// Back up the previous file, then write atomically, keeping the file mode.
function writeSettings(settingsPath, settings, existed, raw, log) {
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let mode = 0o600;
  if (existed) {
    try { mode = fs.statSync(settingsPath).mode & 0o777; } catch {}
    try {
      fs.writeFileSync(settingsPath + '.bak', raw, 'utf8');
      log(`  [ok] Backup written to ${settingsPath}.bak`);
    } catch {}
  }
  const ok = writeJsonAtomic(settingsPath, JSON.stringify(settings, null, 2) + '\n', mode || 0o600);
  if (!ok) log(`  [!!] Failed to write ${settingsPath}`);
  return ok;
}

function printClaudeUsage(settingsPath, log) {
  const rendererPath = path.resolve(__dirname, 'renderer.js').replace(/\\/g, '/');
  const demoPath = path.resolve(__dirname, 'demo.js').replace(/\\/g, '/');
  log(`
  ${'─'.repeat(42)}

  To use Code Crumb:

  1. Open a terminal and run:
     node "${rendererPath}"

  2. Use Claude Code as normal in another terminal.
     The face will react to what Claude is doing!

  3. To preview all expressions:
     node "${demoPath}"

  Plugin install (alternative -- works with marketplace):
     claude plugin install --plugin-dir "${path.resolve(__dirname).replace(/\\/g, '/')}"
     Use ONE of the two: with both the manual hooks and the plugin
     installed every event fires twice and the counters double.

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

  const read = readSettings(settingsPath, log);
  if (read.error) return { ok: false, modified: false, added: 0, replaced: 0, error: read.error };
  const { settings, existed, raw } = read;

  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }

  let added = 0;
  let replaced = 0;
  for (const [event, hookConfigs] of Object.entries(faceHooks)) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    const entries = settings.hooks[event];

    if (entries.some(e => hasExactPath(e, hookPath))) {
      log(`  [ok] ${event} hook already installed`);
      continue;
    }
    // A Code Crumb entry with a different path: the repo moved. Replace it
    // instead of reporting "already installed" and leaving a dead hook.
    if (entries.some(isOurHook)) {
      settings.hooks[event] = entries.filter(e => !isOurHook(e)).concat(hookConfigs);
      replaced++;
      log(`  ~ Updated ${event} hook path`);
      continue;
    }
    entries.push(...hookConfigs);
    added++;
    log(`  + Added ${event} hook`);
  }

  const modified = added + replaced > 0;
  if (modified) {
    if (!writeSettings(settingsPath, settings, existed, raw, log)) {
      return { ok: false, modified: false, added, replaced, error: new Error('write failed') };
    }
    log(`\n  Hooks written to ${settingsPath}`);
  } else {
    log('\n  All hooks already installed');
  }

  if (!opts.quiet) printClaudeUsage(settingsPath, log);
  return { ok: true, modified, added, replaced };
}

// Remove every Code Crumb hook entry (any path) and drop event arrays that
// end up empty. opts: { settingsPath, log }. Returns { ok, removed, error? }.
function uninstallClaude(opts = {}) {
  const settingsPath = opts.settingsPath || DEFAULT_SETTINGS_PATH;
  const log = opts.log || console.log;

  log('\n  Code Crumb Uninstall (Claude Code)');
  log('  ' + '='.repeat(40) + '\n');

  const read = readSettings(settingsPath, log);
  if (read.error) return { ok: false, removed: 0, error: read.error };
  const { settings, existed, raw } = read;

  let removed = 0;
  if (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)) {
    for (const event of Object.keys(settings.hooks)) {
      const entries = settings.hooks[event];
      if (!Array.isArray(entries)) continue;
      const kept = entries.filter(e => !isOurHook(e));
      removed += entries.length - kept.length;
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
// opts { hooksPath, repoRoot, log, quiet } -> { ok, modified, added, replaced, pruned, error? }
function setupCodex(opts = {}) {
  const hooksPath = opts.hooksPath || DEFAULT_CODEX_HOOKS_PATH;
  const log = opts.log || console.log;
  const hookPath = codexHookPath(opts.repoRoot);
  const faceHooks = buildCodexHooks(opts.repoRoot).hooks;

  log('\n  Code Crumb Setup (Codex CLI)');
  log('  ' + '='.repeat(40) + '\n');
  log(`  Platform: ${process.platform}`);
  log(`  Home:     ${HOME}`);
  log(`  Hook:     ${hookPath}\n`);

  const read = readSettings(hooksPath, log, 'Codex hooks');
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
      settings.hooks[event] = entries.filter(e => !isOurHook(e)).concat(hookConfigs);
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
    const kept = entries.filter(e => !isOurHook(e));
    if (kept.length === entries.length) continue;
    pruned += entries.length - kept.length;
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

  if (!opts.quiet) printCodexUsage(hooksPath, log);
  return { ok: true, modified, added, replaced, pruned };
}

// Remove every Code Crumb entry from ~/.codex/hooks.json.
// opts: { hooksPath, log }. Returns { ok, removed, error? }.
function uninstallCodex(opts = {}) {
  const hooksPath = opts.hooksPath || DEFAULT_CODEX_HOOKS_PATH;
  const log = opts.log || console.log;

  log('\n  Code Crumb Uninstall (Codex CLI)');
  log('  ' + '='.repeat(40) + '\n');

  const read = readSettings(hooksPath, log, 'Codex hooks');
  if (read.error) return { ok: false, removed: 0, error: read.error };
  const { settings, existed, raw } = read;

  let removed = 0;
  if (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)) {
    for (const event of Object.keys(settings.hooks)) {
      const entries = settings.hooks[event];
      if (!Array.isArray(entries)) continue;
      const kept = entries.filter(e => !isOurHook(e));
      removed += entries.length - kept.length;
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

function setupCodexNotify() {
  const CODEX_CONFIG = path.join(HOME, '.codex', 'config.toml');
  const notifyPath = path.resolve(__dirname, 'adapters', 'codex-notify.js').replace(/\\/g, '/');
  const wrapperPath = path.resolve(__dirname, 'adapters', 'codex-wrapper.js').replace(/\\/g, '/');
  const rendererPath = path.resolve(__dirname, 'renderer.js').replace(/\\/g, '/');

  console.log('\n  Code Crumb Setup (Codex CLI -- legacy notify)');
  console.log('  ' + '='.repeat(40) + '\n');
  console.log(`  Platform: ${process.platform}`);
  console.log(`  Home:     ${HOME}`);
  console.log(`  Adapter:  ${notifyPath}\n`);

  // Read existing config or create new
  let configText = '';
  let hasNotify = false;
  try {
    configText = fs.readFileSync(CODEX_CONFIG, 'utf8');
    hasNotify = /^\s*notify\s*=/m.test(configText);
    console.log('  [ok] Found existing Codex config');
  } catch {
    console.log('  [..] No existing config found');
  }

  if (hasNotify) {
    // Check if our handler is already configured
    if (configText.includes('codex-notify.js')) {
      console.log('  [ok] Code Crumb notify handler already configured');
    } else {
      console.log('\n  [!!] Codex already has a notify handler configured.');
      console.log('  To add Code Crumb, edit ~/.codex/config.toml:');
      console.log(`  notify = ["node", "${notifyPath}"]`);
    }
  } else {
    // Append notify config
    const notifyLine = `# Code Crumb integration\nnotify = ["node", "${notifyPath}"]\n\n`;
    const codexDir = path.dirname(CODEX_CONFIG);
    if (!fs.existsSync(codexDir)) {
      fs.mkdirSync(codexDir, { recursive: true });
    }
    // Insert at top so the key is at global scope (not under a [section])
    fs.writeFileSync(CODEX_CONFIG, notifyLine + configText, 'utf8');
    console.log(`  + Added notify handler to ${CODEX_CONFIG}`);
  }

  console.log(`
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

  WRAPPER MODE (rich, headless \`codex exec\` runs):
       node "${wrapperPath}" "your prompt"
     This intercepts the JSONL stream for real-time
     tool-level face reactions.

  ${'─'.repeat(42)}
`);
}

// -- OpenCode Setup --------------------------------------------------

function setupOpenCode() {
  const adapterPath = path.resolve(__dirname, 'adapters', 'opencode-adapter.js').replace(/\\/g, '/');
  const rendererPath = path.resolve(__dirname, 'renderer.js').replace(/\\/g, '/');

  console.log('\n  Code Crumb Setup (OpenCode)');
  console.log('  ' + '='.repeat(40) + '\n');
  console.log(`  Platform: ${process.platform}`);
  console.log(`  Home:     ${HOME}`);
  console.log(`  Adapter:  ${adapterPath}\n`);

  console.log(`
  ${'─'.repeat(42)}

  OpenCode uses a plugin system to emit events. Create a plugin
  that pipes events to the Code Crumb adapter.

  STEP 1: Create the plugin file
  ${'─'.repeat(38)}

  Create: ~/.config/opencode/plugins/code-crumb.js

    const { execSync } = require('child_process');
    const adapter = '${adapterPath}';

    function send(payload) {
      try {
        execSync(\`node "\${adapter}"\`,
          { input: JSON.stringify(payload), timeout: 200, stdio: ['pipe','ignore','ignore'],
            env: { ...process.env, CLAUDE_SESSION_ID: payload.session_id || '' } });
      } catch {}
    }

    export const CodeCrumbPlugin = async ({ project, client, $, directory, worktree }) => {
      let lastMessageContent = '';
      let toolsCalledThisTurn = false;
      let sessionId = '';
      return {
        'session.created': async (input, output) => {
          toolsCalledThisTurn = false;
          sessionId = input.sessionId || '';
          send({ type: 'session.created', session_id: sessionId });
        },
        'message.part.updated': async (input, output) => {
          const content = input.part?.content || '';
          const role = input.part?.role || '';
          if (content !== lastMessageContent) {
            lastMessageContent = content;
            const isThinking = role === 'assistant' && !toolsCalledThisTurn && content.length > 0;
            const thinkingText = isThinking
              ? (content.split(' ').slice(0, 3).join(' ') || 'analyzing')
              : '';
            send({
              type: 'message.part.updated',
              session_id: sessionId,
              content: content.substring(0, 500),
              role,
              is_thinking: isThinking,
              thinking: thinkingText,
              tools_called: toolsCalledThisTurn
            });
          }
        },
        'tool.execute.before': async (input, output) => {
          toolsCalledThisTurn = true;
          send({ type: 'tool.execute.before', session_id: sessionId, input: { tool: input.tool, args: input.args } });
        },
        'tool.execute.after': async (input, output) => {
          send({ type: 'tool.execute.after', session_id: sessionId, input: { tool: input.tool, args: input.args }, output });
        },
        'session.idle': async (input, output) => {
          toolsCalledThisTurn = false;
          send({ type: 'session.idle', session_id: sessionId });
        },
        'session.error': async (input, output) => {
          send({ type: 'session.error', session_id: sessionId, output: { error: input.error || 'Session error' } });
        },
      };
    };

  STEP 2: Load the plugin
  ${'─'.repeat(38)}

  Add to ~/.config/opencode/opencode.json:

    {
      "plugins": ["./plugins/code-crumb.js"]
    }

  STEP 3: Run the renderer
  ${'─'.repeat(38)}

  Start the renderer before using OpenCode:
    node "${rendererPath}"

  Then use OpenCode normally -- the face will react to tools!

  OpenCode events handled:
    session.created       → shows waiting face (session started)
    message.part.updated  → shows thinking face when AI is analyzing
    tool.execute.before   → shows tool activity (reading/editing/running)
    tool.execute.after    → shows outcome (happy/error/relieved)
    session.idle          → shows happy face (all done)
    session.error         → shows error face

  ${'─'.repeat(42)}
`);
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
      const { execSync } = require('child_process');
      const adapter = '${adapterPath}';

      function send(payload) {
        try {
          execSync(\`node "\${adapter}"\`,
            { input: JSON.stringify(payload), timeout: 2000, stdio: ['pipe','ignore','ignore'] });
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

function enableAutolaunch(log = console.log) {
  savePrefs({ autolaunch: true });
  log('  [ok] Autolaunch enabled -- the renderer will start automatically on the first hook call');
}

// -- CLI -------------------------------------------------------------

function printUsage() {
  console.log('  Supported editors: claude, codex, codex-notify, opencode, openclaw');
  console.log('  Usage: node setup.js [claude|codex|codex-notify|opencode|openclaw|uninstall] [--autolaunch]\n');
}

function main() {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs.filter(a => !a.startsWith('--'));
  const flags = rawArgs.filter(a => a.startsWith('--'));
  const autolaunchFlag = flags.includes('--autolaunch');
  const command = (args[0] || '').toLowerCase();

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
      // Codex hooks live in their own file; clean them up too if present.
      let codexOk = true;
      if (fs.existsSync(DEFAULT_CODEX_HOOKS_PATH)) {
        codexOk = uninstallCodex().ok;
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
    case 'notify':
      setupCodexNotify();
      break;
    case 'opencode':
      setupOpenCode();
      break;
    case 'openclaw':
    case 'claw':
    case 'pi':
      setupOpenClaw();
      break;
    default:
      console.log(`\n  Unknown editor: "${command}"`);
      printUsage();
      process.exit(1);
  }

  if (autolaunchFlag) {
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
  uninstallClaude,
  buildFaceHooks,
  setupCodex,
  uninstallCodex,
  buildCodexHooks,
  enableAutolaunch,
  HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  DEFAULT_HOOK_PATH,
  DEFAULT_SETTINGS_PATH,
  DEFAULT_CODEX_HOOKS_PATH,
};
