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

// Parse our own flags (consumed here, not passed to the editor)
const rawArgs = process.argv.slice(2);

// Parse --editor flag
let editorName = 'claude';
const editorIdx = rawArgs.indexOf('--editor');
if (editorIdx !== -1 && rawArgs[editorIdx + 1]) {
  editorName = rawArgs[editorIdx + 1].toLowerCase();
}

// Remove our consumed flags, pass the rest to the editor
const editorArgs = rawArgs.filter((a, i) =>
  a !== '--editor' && (editorIdx === -1 || i !== editorIdx + 1)
);

const rendererPath = path.resolve(__dirname, 'renderer.js');
const rendererArgs = [rendererPath];
const windowTitle = 'Code Crumb';

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

  if (platform === 'win32') {
    // Try Windows Terminal first, fall back to cmd start
    let hasWt = false;
    try { execSync('where wt', { stdio: 'ignore' }); hasWt = true; } catch {}

    if (hasWt) {
      spawn('wt', ['-w', '0', 'new-tab', '--title', windowTitle, 'node', ...rendererArgs], {
        detached: true,
        stdio: 'ignore',
        shell: true,
      }).unref();
    } else {
      spawn('cmd', ['/c', 'start', `"${windowTitle}"`, 'node', ...rendererArgs], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    }
  } else if (platform === 'darwin') {
    const escaped = rendererArgs.map(a => a.replace(/'/g, "'\\''")).join(' ');
    spawn('osascript', ['-e', `tell application "Terminal" to do script "node ${escaped}; exit"`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else {
    const terminals = [
      ['gnome-terminal', ['--title=' + windowTitle, '--', 'node', ...rendererArgs]],
      ['konsole', ['--new-tab', '-e', 'node', ...rendererArgs]],
      ['xfce4-terminal', ['--title=' + windowTitle, '-e', `node ${rendererArgs.join(' ')}`]],
      ['xterm', ['-T', windowTitle, '-e', 'node', ...rendererArgs]],
    ];

    let launched = false;
    for (const [cmd, args] of terminals) {
      try {
        execSync(`command -v ${cmd}`, { stdio: 'ignore' });
        {
          spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
          launched = true;
          break;
        }
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

// --- Main ---

if (!isRendererRunning()) {
  startRenderer();
  // Brief pause to let the renderer window appear
  const start = Date.now();
  while (Date.now() - start < 500) { /* spin */ }
}

// Resolve editor command and args
let editorCmd, editorCmdArgs;

switch (editorName) {
  case 'codex':
  case 'openai': {
    // Use the Codex wrapper for rich tool-level events
    const wrapperPath = path.resolve(__dirname, 'adapters', 'codex-wrapper.js');
    editorCmd = 'node';
    editorCmdArgs = [wrapperPath, ...editorArgs];
    break;
  }
  case 'opencode': {
    editorCmd = 'opencode';
    editorCmdArgs = editorArgs;
    break;
  }
  case 'openclaw':
  case 'claw':
  case 'pi': {
    editorCmd = 'openclaw';
    editorCmdArgs = editorArgs;
    break;
  }
  case 'claude':
  case 'claude-code':
  default: {
    editorCmd = 'claude';
    editorCmdArgs = editorArgs;
    break;
  }
}

// Pass remaining arguments through to the editor
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
