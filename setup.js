#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Setup -- configures hooks for supported editors         |
// |  Works on Windows, macOS, and Linux                              |
// |                                                                  |
// |  Usage:                                                          |
// |    node setup.js              (Claude Code -- default)           |
// |    node setup.js claude       (Claude Code -- explicit)          |
// |    node setup.js codex        (Codex CLI)                        |
// |    node setup.js opencode     (OpenCode)                         |
// |    node setup.js openclaw     (OpenClaw / Pi)                    |
// +================================================================+

const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '/tmp';
const HOOK_SCRIPT = path.resolve(__dirname, 'update-state.js');

// Normalise to forward slashes -- works in Node on all platforms
// and avoids JSON escaping nightmares with backslashes
const hookPath = HOOK_SCRIPT.replace(/\\/g, '/');

// -- Editor detection ------------------------------------------------

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = process.argv.slice(2).filter(a => a.startsWith('--'));
const editor = (args[0] || 'claude').toLowerCase();
const autolaunchFlag = flags.includes('--autolaunch');

// -- Claude Code Setup -----------------------------------------------

function setupClaude() {
  const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');

  const hookEvents = [
    'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop',
    'Notification', 'SubagentStart', 'SubagentStop',
    'TeammateIdle', 'TaskCompleted', 'SessionStart', 'SessionEnd',
  ];

  const faceHooks = {};
  for (const event of hookEvents) {
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

  console.log('\n  Code Crumb Setup (Claude Code)');
  console.log('  ' + '='.repeat(40) + '\n');
  console.log(`  Platform: ${process.platform}`);
  console.log(`  Home:     ${HOME}`);
  console.log(`  Hook:     ${hookPath}\n`);

  // Read existing settings
  let settings = {};
  try {
    const raw = fs.readFileSync(CLAUDE_SETTINGS, 'utf8');
    settings = JSON.parse(raw);
    console.log('  [ok] Found existing Claude settings');
  } catch {
    console.log('  [..] No existing settings found, creating new');
  }

  // Merge hooks (don't overwrite existing hooks)
  if (!settings.hooks) {
    settings.hooks = {};
  }

  let modified = false;
  for (const [event, hookConfigs] of Object.entries(faceHooks)) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    // Check if our hook is already installed
    const alreadyInstalled = settings.hooks[event].some(h =>
      h.hooks?.some(hh => hh.command?.includes('update-state.js'))
    );

    if (!alreadyInstalled) {
      settings.hooks[event].push(...hookConfigs);
      modified = true;
      console.log(`  + Added ${event} hook`);
    } else {
      console.log(`  [ok] ${event} hook already installed`);
    }
  }

  if (modified) {
    // Ensure .claude directory exists
    const claudeDir = path.dirname(CLAUDE_SETTINGS);
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    // Write settings
    fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), 'utf8');
    console.log(`\n  Hooks written to ${CLAUDE_SETTINGS}`);
  } else {
    console.log('\n  All hooks already installed');
  }

  const rendererPath = path.resolve(__dirname, 'renderer.js').replace(/\\/g, '/');
  const demoPath = path.resolve(__dirname, 'demo.js').replace(/\\/g, '/');

console.log(`
  ${'─'.repeat(42)}

  To use Code Crumb:

  1. Open a terminal and run:
     node "${rendererPath}"

  2. Use Claude Code as normal in another terminal.
     The face will react to what Claude is doing!

  3. To preview all expressions:
     node "${demoPath}"

  Plugin install (recommended -- works with marketplace):
     claude plugin install --plugin-dir "${path.resolve(__dirname).replace(/\\/g, '/')}"

  To uninstall:
     claude plugin uninstall code-crumb
  Or remove the code-crumb hooks manually from:
     ${CLAUDE_SETTINGS}

  ${'─'.repeat(42)}
`);
}

// -- Codex CLI Setup -------------------------------------------------

function setupCodex() {
  const CODEX_CONFIG = path.join(HOME, '.codex', 'config.toml');
  const notifyPath = path.resolve(__dirname, 'adapters', 'codex-notify.js').replace(/\\/g, '/');
  const wrapperPath = path.resolve(__dirname, 'adapters', 'codex-wrapper.js').replace(/\\/g, '/');
  const rendererPath = path.resolve(__dirname, 'renderer.js').replace(/\\/g, '/');

  console.log('\n  Code Crumb Setup (Codex CLI)');
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
    const notifyLine = `\n# Code Crumb integration\nnotify = ["node", "${notifyPath}"]\n`;
    const codexDir = path.dirname(CODEX_CONFIG);
    if (!fs.existsSync(codexDir)) {
      fs.mkdirSync(codexDir, { recursive: true });
    }
    fs.writeFileSync(CODEX_CONFIG, configText + notifyLine, 'utf8');
    console.log(`  + Added notify handler to ${CODEX_CONFIG}`);
  }

  console.log(`
  ${'─'.repeat(42)}

  Codex CLI integration has two modes:

  1. NOTIFY MODE (basic -- turn-level events only):
     Already configured above. The face will react when
     Codex completes a turn. Start the renderer:
       node "${rendererPath}"
     Then use Codex normally.

  2. WRAPPER MODE (rich -- tool-level events):
     Use the wrapper instead of \`codex exec\`:
       node "${wrapperPath}" "your prompt"
     This intercepts the JSONL stream for real-time
     tool-level face reactions.

  Note: Codex CLI lacks a hook system, so interactive
  TUI sessions cannot be observed at the tool level.

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
          { input: JSON.stringify(payload), timeout: 200, stdio: ['pipe','ignore','ignore'] });
      } catch {}
    }

    export const CodeCrumbPlugin = async ({ project, client, $, directory, worktree }) => {
      let lastMessageContent = '';
      let toolsCalledThisTurn = false;
      return {
        'session.created': async (input, output) => {
          toolsCalledThisTurn = false;
          send({ type: 'session.created', session_id: input.sessionId });
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
          send({ type: 'tool.execute.before', input: { tool: input.tool, args: input.args } });
        },
        'tool.execute.after': async (input, output) => {
          send({ type: 'tool.execute.after', input: { tool: input.tool, args: input.args }, output });
        },
        'session.idle': async (input, output) => {
          toolsCalledThisTurn = false;
          send({ type: 'session.idle' });
        },
        'session.error': async (input, output) => {
          send({ type: 'session.error', output: { error: input.error || 'Session error' } });
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

// -- Dispatch --------------------------------------------------------

switch (editor) {
  case 'claude':
  case 'claude-code':
    setupClaude();
    break;
  case 'codex':
  case 'openai':
    setupCodex();
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
    console.log(`\n  Unknown editor: "${editor}"`);
    console.log('  Supported editors: claude, codex, opencode, openclaw');
    console.log('  Usage: node setup.js [claude|codex|opencode|openclaw] [--autolaunch]\n');
    process.exit(1);
}

// -- Autolaunch preference -------------------------------------------

const PREFS_FILE = path.join(HOME, '.code-crumb-prefs.json');

function enableAutolaunch() {
  let prefs = {};
  try { prefs = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch {}
  prefs.autolaunch = true;
  fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2), 'utf8');
  console.log('  ✓ Autolaunch enabled — renderer will start automatically on first hook call');
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
