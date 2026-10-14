#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Launcher                                           |
// |  Starts the face renderer (if not running) then launches       |
// |  the specified editor, passing through all arguments.          |
// |                                                                |
// |  Usage:                                                        |
// |    node launch.js                        (face + claude)       |
// |    node launch.js --editor codex "fix bug" (use codex wrapper) |
// |    node launch.js --editor claude -p "fix the bug"             |
// |    node launch.js --dangerously-skip-permissions               |
// |                                                                |
// |  Or via the batch/shell wrappers:                              |
// |    code-crumb                                                  |
// |    code-crumb --dangerously-skip-permissions                   |
// +================================================================+

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const { PID_FILE, buildRendererCommands, quoteArg, isRendererAlive, spawnRendererWindow } = require('./lib/shared');

const WINDOW_TITLE = 'Code Crumb';

// -- Pure helpers (exported for tests) ------------------------------------

/**
 * Parse --editor flag from raw argv, return { editorName, editorArgs }.
 * Consumes --editor <name> and passes everything else through.
 */
function parseArgs(rawArgs) {
  let editorName = 'claude';
  const editorIdx = rawArgs.indexOf('--editor');
  if (editorIdx !== -1 && rawArgs[editorIdx + 1]) {
    editorName = rawArgs[editorIdx + 1].toLowerCase();
  }

  const editorArgs = rawArgs.filter((a, i) =>
    a !== '--editor' && (editorIdx === -1 || i !== editorIdx + 1)
  );

  return { editorName, editorArgs };
}

/**
 * Given an editor name and passthrough args, return { cmd, args } describing
 * the command to spawn.  baseDir is the project root (for codex wrapper path).
 */
function resolveEditor(editorName, editorArgs, baseDir) {
  switch (editorName) {
    case 'codex':
    case 'openai': {
      const wrapperPath = path.resolve(baseDir, 'adapters', 'codex-wrapper.js');
      return { cmd: 'node', args: [wrapperPath, ...editorArgs] };
    }
    case 'opencode':
      return { cmd: 'opencode', args: editorArgs };
    case 'openclaw':
    case 'claw':
    case 'pi':
      return { cmd: 'openclaw', args: editorArgs };
    case 'claude':
    case 'claude-code':
    default:
      return { cmd: 'claude', args: editorArgs };
  }
}

// buildRendererCommands(platform, rendererArgs, windowTitle) lives in
// shared.js so update-state.js (autolaunch) and this launcher spawn the
// renderer the same way; it is re-exported below for existing importers.

/**
 * How to spawn the editor itself. On Windows, `claude`, `opencode` and
 * `openclaw` are .cmd shims, which Node refuses to spawn without a shell
 * (CVE-2024-27980 fix in 18.20/20.12). shell:true joins args verbatim, so
 * each one is quoted here. `node` (the codex wrapper) is a real executable
 * and keeps the plain, correctly-quoted-by-Node path.
 *
 * Both used to look in the CURRENT folder first, which on Windows is the
 * user's project. cmd.exe tries every PATHEXT extension there before the
 * PATH, so a repository's own codex.cmd, claude.cmd or codex.js (.JS runs in
 * Windows Script Host) ran instead of the tool, and a bare `node` spawn
 * searches the folder too. `node` is therefore this very node, by its full
 * path, and the shell gets NoDefaultCurrentDirectoryInExePath, which turns
 * cmd.exe's current-folder lookup off. The editor inherits the variable, as
 * every process Claude Code itself starts already does. (Claude Code's own
 * shell exports it, so a test run from inside Claude Code never saw this.)
 * `env` is the environment to start from (default process.env).
 */
function buildEditorSpawn(platform, cmd, args, env = process.env) {
  if (cmd === 'node') cmd = process.execPath;
  if (platform === 'win32' && cmd !== process.execPath) {
    return {
      cmd,
      args: args.map(quoteArg),
      opts: { stdio: 'inherit', shell: true, env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' } },
    };
  }
  return { cmd, args, opts: { stdio: 'inherit' } };
}

// -- Editor supervision ---------------------------------------------------
// The terminal sends Ctrl+C (and Ctrl+\) to the whole foreground process
// group, and Windows sends Ctrl+C and Ctrl+Break to every process on the
// console: the editor gets its own copy and decides what it means -- Claude
// Code reads the first Ctrl+C as "cancel". The launcher used to die of that
// same SIGINT, so the shell took the terminal back while the editor kept
// running underneath it, orphaned, fighting the prompt for every key. Those
// signals are ignored here for as long as the editor runs, and the launcher
// leaves with the editor's own exit. A signal aimed at the launcher alone (a
// kill, a SIGHUP) is passed on, so the editor is never left behind.
// On Windows nothing is forwarded: SIGTERM is never delivered there, the
// editor gets a closing console's event itself, and child.kill() would
// TerminateProcess it -- or throw ENOSYS for SIGHUP.

const GROUP_SIGNALS = { win32: ['SIGINT', 'SIGBREAK'], posix: ['SIGINT', 'SIGQUIT'] };
const FORWARD_SIGNALS = { win32: [], posix: ['SIGTERM', 'SIGHUP'] };

// The shell convention for "died of signal N" is 128 + N.
function editorExitCode(code, signal) {
  if (signal) {
    const n = os.constants.signals[signal] || 0;
    return n ? 128 + n : 1;
  }
  return code || 0;
}

// Wire the launcher to a spawned editor. proc and exit are test seams.
function superviseEditor(child, { platform = process.platform, proc = process, exit = (c) => process.exit(c) } = {}) {
  const kind = platform === 'win32' ? 'win32' : 'posix';
  const installed = [];
  const on = (sig, fn) => {
    try { proc.on(sig, fn); installed.push([sig, fn]); } catch {}
  };
  for (const sig of GROUP_SIGNALS[kind]) on(sig, () => {});
  for (const sig of FORWARD_SIGNALS[kind]) on(sig, () => { try { child.kill(sig); } catch {} });

  // A signal-killed editor is a failure, not exit 0: report it the shell way
  // (128 + signal number), as the codex wrapper and engmux adapter do.
  child.on('exit', (code, signal) => {
    for (const [sig, fn] of installed) proc.removeListener(sig, fn);
    exit(editorExitCode(code, signal));
  });
}

// -- Side-effecting runtime -----------------------------------------------

// Same liveness rule as the hook's autolaunch and the renderer's own guard.
function isRendererRunning() {
  return isRendererAlive(PID_FILE);
}

function startRenderer() {
  const rendererPath = path.resolve(__dirname, 'renderer.js');
  if (!spawnRendererWindow(rendererPath, WINDOW_TITLE)) {
    console.error('  Could not find a terminal emulator to launch the face.');
    console.error('  Start it manually: node ' + rendererPath);
  }
}

// -- Main (only when executed directly) -----------------------------------

if (require.main === module) {
  const rawArgs = process.argv.slice(2);

  // --version / -v
  if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
    console.log(require('./package.json').version);
    process.exit(0);
  }

  const { editorName, editorArgs } = parseArgs(rawArgs);

  if (!isRendererRunning()) {
    startRenderer();
    // Wait 500ms for renderer to initialize (without busy-waiting)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }

  const { cmd: editorCmd, args: editorCmdArgs } = resolveEditor(editorName, editorArgs, __dirname);
  const spawnSpec = buildEditorSpawn(process.platform, editorCmd, editorCmdArgs);

  const child = spawn(spawnSpec.cmd, spawnSpec.args, spawnSpec.opts);

  child.on('error', (err) => {
    console.error(`Failed to start ${editorName}:`, err.message);
    process.exit(1);
  });

  superviseEditor(child);
}

// -- Exports for testing --------------------------------------------------

module.exports = {
  parseArgs, resolveEditor, buildRendererCommands, buildEditorSpawn, superviseEditor, editorExitCode,
  WINDOW_TITLE,
};
