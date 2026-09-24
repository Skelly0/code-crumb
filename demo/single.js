#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Demo -- cycles through all 23 states               |
// |  Run this to preview all the face expressions!                 |
// |  Includes thought bubbles, streaks, a milestone, the timeline, |
// |  orbital subagents, and a fast tool loop for linger timing.    |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { STATE_FILE, SESSIONS_DIR, safeFilename, writeJsonAtomic } = require('../lib/shared');

// Ensure sessions dir exists for orbital demo
try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

const mainId = 'demo-main';
const demoPromptAt = Date.now();

// The renderer follows the main's SESSION file; the global file is kept for
// tmux mode. A `stopped` demo write is a turn end on the session file.
function writeState(state, detail = '', extra = {}) {
  const data = { state, detail, timestamp: Date.now(), sessionId: mainId, modelName: 'claude', ...extra };
  fs.writeFileSync(STATE_FILE, JSON.stringify(data), 'utf8');
  const session = { session_id: mainId, ...data, lastPromptAt: demoPromptAt, cwd: process.cwd() };
  if (session.stopped) { delete session.stopped; session.turnEnded = true; }
  // Atomic: this is the file the main face follows, and the renderer polls it
  // 15 times a second -- a torn read costs a frame.
  writeJsonAtomic(path.join(SESSIONS_DIR, safeFilename(mainId) + '.json'), session);
}

function writeSession(id, state, detail, cwd, stopped = false, taskDescription) {
  const data = {
    session_id: id, state, detail, timestamp: Date.now(),
    cwd: cwd || process.cwd(), stopped, modelName: 'claude',
    parentSession: mainId,
  };
  if (taskDescription) data.taskDescription = taskDescription;
  fs.writeFileSync(path.join(SESSIONS_DIR, safeFilename(id) + '.json'), JSON.stringify(data), 'utf8');
}

function removeSession(id) {
  try { fs.unlinkSync(path.join(SESSIONS_DIR, safeFilename(id) + '.json')); } catch {}
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const subagents = [
  { id: 'demo-sub-1', cwd: '/home/user/my-app/src', taskDescription: 'fix auth tests' },
  { id: 'demo-sub-2', cwd: '/home/user/my-app/tests', taskDescription: 'add logging' },
  { id: 'demo-sub-3', cwd: '/home/user/api-server', taskDescription: 'refactor db' },
];

// The main's session file is a live top-level candidate with a fresh
// lastPromptAt, so it must be unlinked on the way out -- otherwise the demo
// face outlives the demo and hides the user's real editor session.
function cleanupSessions() {
  for (const s of subagents) removeSession(s.id);
  removeSession(mainId);
}

// Every way a terminal ends a demo, not just Ctrl+C: closing the window sends
// SIGHUP (Node emulates it on win32 when the console closes) and a kill sends
// SIGTERM. Missing either left demo-main behind with a fresh lastPromptAt,
// holding the center over the user's real session until it went stale.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanupSessions(); process.exit(0); });
}

// Simulate a session with incrementing tool calls and streak
let toolCalls = 0;
let filesEdited = 0;
let streak = 0;
const sessionStart = Date.now();

function statsExtra(extra = {}) {
  return {
    toolCalls, filesEdited, sessionStart,
    streak, bestStreak: streak,
    brokenStreak: 0, brokenStreakAt: 0,
    milestone: streak === 10 ? { type: 'streak', value: 10, at: Date.now() } : null,
    ...extra,
  };
}

// Fast tool loop: Edit/Read PreToolUse+PostToolUse pairs 150ms apart, the way
// a real session hammers the state file. Each reward face (proud/satisfied)
// should still hold the screen for ~1.8s, with the work face between them.
async function fastToolLoop() {
  const files = ['App.tsx', 'utils.ts', 'styles.css', 'index.ts', 'api.ts', 'hooks.ts'];
  for (const f of files) {
    toolCalls++; filesEdited++;
    writeState('coding', `editing ${f}`, statsExtra());
    await sleep(150);
    streak++;
    writeState('proud', `saved ${f}`, statsExtra({ workState: 'coding', workDetail: `editing ${f}`, diffInfo: { added: 3, removed: 1 } }));
    await sleep(150);
    toolCalls++;
    writeState('reading', `reading ${f}`, statsExtra());
    await sleep(150);
    streak++;
    writeState('satisfied', `read ${f}`, statsExtra({ workState: 'reading', workDetail: `reading ${f}` }));
    await sleep(150);
  }
  await sleep(6000);
}

const states = [
  { state: 'idle',       detail: '',                         duration: 3000, label: 'Idle -- resting, thought bubbles drift in' },
  { state: 'starting',   detail: 'setting up',               duration: 2500, label: 'Starting -- booting up' },
  { state: 'thinking',   detail: 'reading your message',     duration: 3500, label: 'Thinking -- eyes spinning, orbiting particles' },
  { state: 'responding', detail: 'generating response',      duration: 3500, label: 'Responding -- after tools, final output (echo particles)' },
  { state: 'reading',    detail: 'reading index.ts',         duration: 3000, label: 'Reading -- narrowed eyes, tool call count shows' },
  { state: 'searching',  detail: 'looking for "TODO"',       duration: 3500, label: 'Searching -- eyes darting left and right' },
  { state: 'coding',     detail: 'editing App.tsx',          duration: 3500, label: 'Coding -- file count in thought bubble', files: true },
  { state: 'coding',     detail: 'editing utils.ts',         duration: 2000, label: 'More coding -- file count grows', files: true },
  { state: 'coding',     detail: 'editing styles.css',       duration: 2000, label: 'Even more -- thought bubble tracks files', files: true },
  { state: 'reviewing',  detail: 'report findings',          duration: 3000, label: 'Reviewing -- scanning the diff with intent' },
  { state: 'executing',  detail: 'npm run build',            duration: 3000, label: 'Executing -- running a command' },
  { state: 'satisfied',  detail: 'got it',                   duration: 3000, label: 'Satisfied -- calm after reading, streak building', success: true },
  { state: 'proud',      detail: 'saved App.tsx',            duration: 3000, label: 'Proud -- nailed a code edit!', success: true },
  { state: 'relieved',   detail: 'command succeeded',        duration: 3000, label: 'Relieved -- command ran clean', success: true },
  { state: 'proud',      detail: 'saved utils.ts',           duration: 2000, label: 'Proud again -- another clean edit', success: true },
  { state: 'satisfied',  detail: 'step complete',            duration: 2000, label: 'Satisfied -- steady progress', success: true },
  { state: 'committing', detail: 'git commit -m "feat"',     duration: 3500, label: 'Committing -- data streams out' },
  { state: 'proud',      detail: 'committed',                duration: 3000, label: 'Proud -- committed!', success: true },
  { state: 'waiting',    detail: 'asking you',               duration: 3000, label: 'Waiting -- asking you a question (question marks)' },
  { state: 'satisfied',  detail: 'got your answer',          duration: 2500, label: 'Satisfied -- got your answer', success: true },
  { state: 'reading',    detail: 'skill: brainstorming',     duration: 2500, label: 'Reading -- loading a skill' },
  { state: 'satisfied',  detail: 'skill loaded',             duration: 2500, label: 'Satisfied -- skill loaded', success: true },
  { state: 'testing',    detail: 'npm test',                 duration: 3500, label: 'Testing -- nervous energy, sweat drops' },
  { state: 'relieved',   detail: '1661 tests passed',        duration: 3000, label: 'Relieved -- tests pass', success: true },
  { state: 'happy',      detail: 'agent done',               duration: 4000, label: 'Happy -- streak hits 10, milestone!', success: true },
  { state: 'error',      detail: 'build failed (exit 1)',    duration: 4000, label: 'Error! -- streak broken, dramatic reaction!', error: true },
  { state: 'sleeping',   detail: '',                         duration: 3500, label: 'Sleeping -- zzz, drifted off' },
  { state: 'waiting',    detail: 'needs input',              duration: 3000, label: 'Waiting -- needs user attention' },
  { state: 'installing', detail: 'npm install',              duration: 3000, label: 'Installing -- packages raining down' },
  { state: 'training',   detail: 'torchrun train.py',        duration: 5000, label: 'Training -- the forge burns, embers rise' },
  { state: 'caffeinated', detail: 'hyperdrive mode!',        duration: 3000, label: 'Caffeinated -- wired, vibrating' },
  // -- Linger timing check --
  { label: 'Fast tool loop -- 6 Edit/Read pairs at 150ms; every reward face should still hold ~1.8s',
    scene: fastToolLoop },
  // -- Orbital subagent sequence --
  { state: 'spawning',   detail: 'subagent',                 duration: 2500, label: 'Spawning -- a helper boots up' },
  { state: 'subagent', detail: 'spawning subagent', duration: 3000, label: 'Subagent -- first orbital spawns!',
    orbital: () => {
      writeSession(subagents[0].id, 'reading', 'reading index.ts', subagents[0].cwd, false, subagents[0].taskDescription);
    }},
  { state: 'subagent', detail: 'conducting', duration: 3000, label: 'Second orbital -- two subagents now',
    orbital: () => {
      writeSession(subagents[0].id, 'coding', 'editing App.tsx', subagents[0].cwd, false, subagents[0].taskDescription);
      writeSession(subagents[1].id, 'testing', 'npm test', subagents[1].cwd, false, subagents[1].taskDescription);
    }},
  { state: 'subagent', detail: 'conducting', duration: 4000, label: 'Third orbital -- full constellation!',
    orbital: () => {
      writeSession(subagents[2].id, 'searching', 'looking for TODO', subagents[2].cwd, false, subagents[2].taskDescription);
      writeSession(subagents[0].id, 'training', 'fine-tuning', subagents[0].cwd, false, subagents[0].taskDescription);
      writeSession(subagents[1].id, 'reviewing', 'report findings', subagents[1].cwd, false, subagents[1].taskDescription);
    }},
  { state: 'subagent', detail: 'conducting', duration: 5000, label: 'Orbitals working -- good time for a screenshot!',
    orbital: () => {
      writeSession(subagents[0].id, 'executing', 'npm run build', subagents[0].cwd, false, subagents[0].taskDescription);
      writeSession(subagents[1].id, 'proud', 'code written', subagents[1].cwd, false, subagents[1].taskDescription);
      writeSession(subagents[2].id, 'coding', 'editing handler.ts', subagents[2].cwd, false, subagents[2].taskDescription);
    }},
  { state: 'subagent', detail: 'wrapping up', duration: 3000, label: 'Subagents finishing up',
    orbital: () => {
      writeSession(subagents[0].id, 'happy', 'all done!', subagents[0].cwd, true, subagents[0].taskDescription);
      writeSession(subagents[1].id, 'happy', 'all done!', subagents[1].cwd, true, subagents[1].taskDescription);
      writeSession(subagents[2].id, 'happy', 'all done!', subagents[2].cwd, true, subagents[2].taskDescription);
    }},
  { state: 'happy',      detail: 'all done!',                duration: 3000, label: 'Done! -- check out that timeline bar', success: true },
  { state: 'idle',       detail: '',                         duration: 2000, label: 'Back to idle -- the cycle of life' },
];

console.log('\n  Code Crumb Demo');
console.log('  ' + '='.repeat(40));
console.log('  Make sure the renderer is running in another terminal!');
console.log('  (node renderer.js)\n');
console.log('  Watch for thought bubbles, streak counter,');
console.log('  timeline bar, and orbital subagents!\n');

async function runDemo() {
  for (const s of states) {
    console.log(`  > ${s.label}`);
    if (s.scene) {
      await s.scene();
      continue;
    }
    toolCalls++;
    if (s.files) filesEdited++;
    if (s.success) streak++;
    if (s.error) {
      const broken = streak;
      streak = 0;
      writeState(s.state, s.detail, {
        toolCalls, filesEdited, sessionStart,
        streak: 0, bestStreak: broken,
        brokenStreak: broken, brokenStreakAt: Date.now(),
        milestone: null,
      });
    } else {
      writeState(s.state, s.detail, statsExtra());
    }
    // Spawn/update orbital subagent sessions
    if (s.orbital) s.orbital();
    await sleep(s.duration);
  }

  // Clean up orbital session files and the main's own session file
  cleanupSessions();
  console.log('\n  Demo complete! The face should now be idle.\n');
}

runDemo();
