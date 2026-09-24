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
const { PID_FILE, buildRendererCommands, quoteArg, isRendererAlive, spawnRendererWindow } = require('./shared');

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
 */
function buildEditorSpawn(platform, cmd, args) {
  if (platform === 'win32' && cmd !== 'node' && cmd !== process.execPath) {
    return { cmd, args: args.map(quoteArg), opts: { stdio: 'inherit', shell: true } };
  }
  return { cmd, args, opts: { stdio: 'inherit' } };
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

  // A signal-killed editor is a failure, not exit 0: report it the shell way
  // (128 + signal number), as the codex wrapper and engmux adapter do.
  child.on('exit', (code, signal) => {
    if (signal) {
      const n = os.constants.signals[signal] || 0;
      process.exit(n ? 128 + n : 1);
    }
    process.exit(code || 0);
  });
}

// -- Exports for testing --------------------------------------------------

module.exports = { parseArgs, resolveEditor, buildRendererCommands, buildEditorSpawn, WINDOW_TITLE };
