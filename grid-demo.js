#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Orbital Demo                                          |
// |  Simulates subagent sessions orbiting the main face             |
// |  Run renderer.js first! (node renderer.js)                      |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { STATE_FILE, SESSIONS_DIR } = require('./shared');

// Ensure dir exists
try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

function writeMainState(state, detail, sessionId) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    state,
    detail,
    timestamp: Date.now(),
    sessionId,
    modelName: 'claude',
  }), 'utf8');
}

function writeSession(id, state, detail, cwd, stopped = false, extra = {}) {
  const filename = id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
  const data = {
    session_id: id,
    state,
    detail,
    timestamp: Date.now(),
    cwd: cwd || process.cwd(),
    stopped,
    modelName: 'claude',
    parentSession: mainId,
    ...extra,
  };
  fs.writeFileSync(path.join(SESSIONS_DIR, filename), JSON.stringify(data), 'utf8');
}

function removeSession(id) {
  const filename = id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
  try { fs.unlinkSync(path.join(SESSIONS_DIR, filename)); } catch {}
}

const mainId = 'demo-main';

// Subagents grouped by parentSession (will cluster as siblings)
const subagents = [
  { id: 'demo-sub-1', cwd: '/home/user/my-app/src', extra: { taskDescription: 'fix auth' } },
  { id: 'demo-sub-2', cwd: '/home/user/my-app/tests', extra: { taskDescription: 'add logs' } },
];

// Team members (will cluster with team aura label)
const teammates = [
  { id: 'demo-team-1', cwd: '/home/user/backend/api', extra: { teamName: 'backend', teammateName: 'alice', isTeammate: true, parentSession: null } },
  { id: 'demo-team-2', cwd: '/home/user/backend/db', extra: { teamName: 'backend', teammateName: 'bob', isTeammate: true, parentSession: null } },
];

const allSessions = [...subagents, ...teammates];

// Script: a sequence of { time (ms), actions }
const script = [
  {
    time: 0,
    label: 'Main session starts thinking',
    actions: () => {
      writeMainState('thinking', '', mainId);
    },
  },
  {
    time: 3000,
    label: 'Subagent cluster: first child spawns',
    actions: () => {
      writeMainState('subagent', 'spawning subagent', mainId);
      writeSession(subagents[0].id, 'reading', 'reading index.ts', subagents[0].cwd, false, subagents[0].extra);
    },
  },
  {
    time: 5000,
    label: 'Subagent cluster: second child spawns (siblings cluster together)',
    actions: () => {
      writeSession(subagents[1].id, 'testing', 'npm test', subagents[1].cwd, false, subagents[1].extra);
      writeSession(subagents[0].id, 'coding', 'editing App.tsx', subagents[0].cwd, false, subagents[0].extra);
    },
  },
  {
    time: 8000,
    label: 'Team cluster: alice joins (separate group with team aura)',
    actions: () => {
      writeSession(teammates[0].id, 'reading', 'reviewing routes', teammates[0].cwd, false, teammates[0].extra);
    },
  },
  {
    time: 10000,
    label: 'Team cluster: bob joins alice (team "backend" clusters together)',
    actions: () => {
      writeSession(teammates[1].id, 'searching', 'finding schema', teammates[1].cwd, false, teammates[1].extra);
      writeSession(teammates[0].id, 'coding', 'editing api.ts', teammates[0].cwd, false, teammates[0].extra);
      writeSession(subagents[1].id, 'error', 'tests failed', subagents[1].cwd, false, subagents[1].extra);
    },
  },
  {
    time: 13000,
    label: 'Both clusters active — sub-1 caffeinated, team coding',
    actions: () => {
      writeSession(subagents[0].id, 'caffeinated', 'hyperdrive!', subagents[0].cwd, false, subagents[0].extra);
      writeSession(subagents[1].id, 'coding', 'editing fix.ts', subagents[1].cwd, false, subagents[1].extra);
      writeSession(teammates[0].id, 'executing', 'npm run lint', teammates[0].cwd, false, teammates[0].extra);
      writeSession(teammates[1].id, 'coding', 'editing models', teammates[1].cwd, false, teammates[1].extra);
    },
  },
  {
    time: 16000,
    label: 'Team finishes — subagents still working',
    actions: () => {
      writeSession(teammates[0].id, 'happy', 'all done!', teammates[0].cwd, true, teammates[0].extra);
      writeSession(teammates[1].id, 'happy', 'all done!', teammates[1].cwd, true, teammates[1].extra);
      writeSession(subagents[0].id, 'executing', 'npm run build', subagents[0].cwd, false, subagents[0].extra);
    },
  },
  {
    time: 19000,
    label: 'All done — main face goes happy',
    actions: () => {
      writeSession(subagents[0].id, 'happy', 'all done!', subagents[0].cwd, true, subagents[0].extra);
      writeSession(subagents[1].id, 'happy', 'all done!', subagents[1].cwd, true, subagents[1].extra);
      writeMainState('happy', 'all done!', mainId);
    },
  },
];

console.log('\n  Code Crumb Orbital Demo');
console.log('  ' + '='.repeat(40));
console.log('  Make sure renderer.js is running!');
console.log('  (node renderer.js)\n');

async function runDemo() {
  for (const step of script) {
    console.log(`  > ${step.label}`);
    step.actions();
    const nextStep = script[script.indexOf(step) + 1];
    const wait = nextStep ? nextStep.time - step.time : 3000;
    await new Promise(r => setTimeout(r, wait));
  }

  // Clean up demo files
  await new Promise(r => setTimeout(r, 8000));
  for (const s of allSessions) {
    removeSession(s.id);
  }

  console.log('\n  Demo complete! Sessions cleaned up.\n');
}

runDemo();
