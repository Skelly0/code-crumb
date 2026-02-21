#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Launcher                                             |
// |  Starts the face renderer (if not running) then launches        |
// |  the specified editor, passing through all arguments.             |
// |                                                                 |
// |  Usage:                                                         |
// |    node launch.js                        (face + claude)        |
// |    node launch.js --editor codex "fix bug" (use codex wrapper)   |
// |    node launch.js --editor claude -p "fix the bug"               |
// |    node launch.js --dangerously-skip-permissions                 |
// |                                                                 |
// |  Or via the batch/shell wrappers:                               |
// |    code-crumb                                                   |
// |    code-crumb --dangerously-skip-permissions                    |
// +================================================================+

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '/tmp';
const PID_FILE = path.join(HOME, '.code-crumb.pid');
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

/**
 * Build the spawn arguments for launching the renderer in a new terminal
 * on the given platform.  Returns an array of { cmd, args, opts } objects
 * (Linux returns multiple fallback candidates).
 */
function buildRendererCommands(platform, rendererArgs, windowTitle) {
  if (platform === 'win32') {
    return {
      wt: { cmd: 'wt', args: ['-w', '0', 'new-tab', '--title', windowTitle, 'node', ...rendererArgs], opts: { detached: true, stdio: 'ignore', shell: true } },
      cmd: { cmd: 'cmd', args: ['/c', 'start', `"${windowTitle}"`, 'node', ...rendererArgs], opts: { detached: true, stdio: 'ignore' } },
    };
  } else if (platform === 'darwin') {
    const escaped = rendererArgs.map(a => a.replace(/'/g, "'\\''")).join(' ');
    return {
      osascript: { cmd: 'osascript', args: ['-e', `tell application "Terminal" to do script "node ${escaped}; exit"`], opts: { detached: true, stdio: 'ignore' } },
    };
  } else {
    return {
      'gnome-terminal': { cmd: 'gnome-terminal', args: ['--title=' + windowTitle, '--', 'node', ...rendererArgs] },
      konsole:          { cmd: 'konsole', args: ['--new-tab', '-e', 'node', ...rendererArgs] },
      'xfce4-terminal': { cmd: 'xfce4-terminal', args: ['--title=' + windowTitle, '-e', `node ${rendererArgs.join(' ')}`] },
      xterm:            { cmd: 'xterm', args: ['-T', windowTitle, '-e', 'node', ...rendererArgs] },
    };
  }
}

// -- Side-effecting runtime -----------------------------------------------

function isRendererRunning() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startRenderer() {
  const platform = process.platform;
  const rendererPath = path.resolve(__dirname, 'renderer.js');
  const rendererArgs = [rendererPath];

  if (platform === 'win32') {
    let hasWt = false;
    try { execSync('where wt', { stdio: 'ignore' }); hasWt = true; } catch {}

    const cmds = buildRendererCommands(platform, rendererArgs, WINDOW_TITLE);
    if (hasWt) {
      spawn(cmds.wt.cmd, cmds.wt.args, cmds.wt.opts).unref();
    } else {
      spawn(cmds.cmd.cmd, cmds.cmd.args, cmds.cmd.opts).unref();
    }
  } else if (platform === 'darwin') {
    const cmds = buildRendererCommands(platform, rendererArgs, WINDOW_TITLE);
    spawn(cmds.osascript.cmd, cmds.osascript.args, cmds.osascript.opts).unref();
  } else {
    const cmds = buildRendererCommands(platform, rendererArgs, WINDOW_TITLE);
    let launched = false;
    for (const key of Object.keys(cmds)) {
      try {
        execSync(`command -v ${cmds[key].cmd}`, { stdio: 'ignore' });
        spawn(cmds[key].cmd, cmds[key].args, { detached: true, stdio: 'ignore' }).unref();
        launched = true;
        break;
      } catch {
        continue;
      }
    }

    if (!launched) {
      console.error('  Could not find a terminal emulator to launch the face.');
      console.error('  Start it manually: node ' + rendererPath);
    }
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
    const start = Date.now();
    while (Date.now() - start < 500) { /* spin */ }
  }

  const { cmd: editorCmd, args: editorCmdArgs } = resolveEditor(editorName, editorArgs, __dirname);

  const child = spawn(editorCmd, editorCmdArgs, {
    stdio: 'inherit',
    shell: true,
  });

  child.on('error', (err) => {
    console.error(`Failed to start ${editorName}:`, err.message);
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code || 0);
  });
}

// -- Exports for testing --------------------------------------------------

module.exports = { parseArgs, resolveEditor, buildRendererCommands, WINDOW_TITLE };
