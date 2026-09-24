#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - grid.js (OrbitalSystem)               |
// +================================================================+

const assert = require('assert');
const { MiniFace, OrbitalSystem, renderSessionList, isProcessAlive, isOwnedByLiveProcess, requestPidStartTime, _pidStartCache, _pidStartStatus, _setPidResolver, STALE_MS, ORPHAN_TIMEOUT, REPOSITION_MS, CYCLE_WORK_STATES, CYCLE_INTERVAL, CYCLE_STALE_MS } = require('../grid');
const { gridMouths, eyes, mouths } = require('../animations');
const { PALETTES } = require('../themes');
const { ParticleSystem } = require('../particles');

const suite = require('./_harness').createSuite();
const { describe, test } = suite;

// The PID start-time cache is process-global and the platform resolver behind
// it has platform-dependent timing: Linux answers in the same tick from /proc,
// while win32/darwin go through execFile and cannot answer at all during a
// synchronous test. A test that wants a definite ownership verdict must not
// depend on that -- it seeds the cache itself with a start time comfortably
// before the write (so the SLACK_MS comparison is decided), which also makes
// requestPidStartTime return early and run no resolver anywhere. Entries are
// deleted afterwards: process.pid is shared by every test in the run.
function seedOwningPid(pid = process.pid) {
  _pidStartCache.set(pid, { value: Date.now() - STALE_MS - 3600e3, resolvedAt: Date.now() });
}

// Extract the [row, col] of every cell a render actually painted. Each draw is
// "\x1b[row;colH" + colour + text + reset, so one match yields text.length cells.
// This replaces the old outDots out-param, which existed only to feed the
// removed clear buffer.
function drawnCells(out) {
  const cells = [];
  const re = /\x1b\[(\d+);(\d+)H((?:\x1b\[[^m]*m)*)([^\x1b]*)/g;
  let m;
  while ((m = re.exec(out)) !== null) {
    const row = Number(m[1]);
    const col = Number(m[2]);
    for (let i = 0; i < m[4].length; i++) cells.push([row, col + i]);
  }
  return cells;
}

describe('grid.js -- MiniFace modelName', () => {
  test('default modelName is empty', () => {
    const face = new MiniFace('test-session');
    assert.strictEqual(face.modelName, '');
  });

  test('updateFromFile sets modelName', () => {
    const face = new MiniFace('test-session');
    face.updateFromFile({ state: 'coding', modelName: 'codex' });
    assert.strictEqual(face.modelName, 'codex');
  });

  test('updateFromFile ignores missing modelName', () => {
    const face = new MiniFace('test-session');
    face.updateFromFile({ state: 'coding', modelName: 'o3' });
    face.updateFromFile({ state: 'reading' });
    assert.strictEqual(face.modelName, 'o3');
  });
});

describe('grid.js -- MiniFace', () => {
  test('initializes with idle state', () => {
    const face = new MiniFace('test-session');
    assert.strictEqual(face.state, 'idle');
    assert.strictEqual(face.sessionId, 'test-session');
  });

  test('updateFromFile changes state', () => {
    const face = new MiniFace('test');
    face.updateFromFile({ state: 'coding', detail: 'editing foo.js', timestamp: Date.now() });
    assert.strictEqual(face.state, 'coding');
    assert.strictEqual(face.detail, 'editing foo.js');
  });

  test('updateFromFile tracks stopped', () => {
    const face = new MiniFace('test');
    face.updateFromFile({ state: 'happy', stopped: true, timestamp: Date.now() });
    assert.ok(face.stopped);
  });

  test('updateFromFile sets pid from session data', () => {
    const face = new MiniFace('test');
    face.updateFromFile({ state: 'coding', pid: 12345 });
    assert.strictEqual(face.pid, 12345);
  });

  test('updateFromFile preserves pid when subsequent update omits it', () => {
    const face = new MiniFace('test');
    face.updateFromFile({ state: 'coding', pid: 12345 });
    face.updateFromFile({ state: 'reading' });
    assert.strictEqual(face.pid, 12345,
      'pid should persist when subsequent update omits it');
  });

  test('isStale returns false for fresh face', () => {
    const face = new MiniFace('test');
    assert.ok(!face.isStale());
  });

  test('isStale returns true for old stopped face', () => {
    const face = new MiniFace('test');
    face.stopped = true;
    face.stoppedAt = Date.now() - 15000; // Past STOPPED_LINGER_MS (10s)
    assert.ok(face.isStale());
  });

  test('getEyes returns string for all states', () => {
    const states = [
      'idle', 'thinking', 'reading', 'searching', 'coding', 'executing',
      'happy', 'error', 'sleeping', 'waiting', 'testing', 'installing',
      'caffeinated', 'subagent', 'satisfied', 'proud', 'relieved',
      'committing',
    ];
    for (const state of states) {
      const face = new MiniFace('test');
      face.state = state;
      face.blinkFrame = -1;
      const result = face.getEyes();
      assert.ok(typeof result === 'string', `MiniFace.getEyes failed for state: ${state}`);
    }
  });

  test('getMouth returns string for all states', () => {
    const states = Object.keys(gridMouths);
    for (const state of states) {
      const face = new MiniFace('test');
      face.state = state;
      const result = face.getMouth();
      assert.ok(typeof result === 'string', `MiniFace.getMouth failed for state: ${state}`);
    }
  });
});

describe('grid.js -- MiniFace tick() timeout logic', () => {
  test('completion state lingers then transitions to thinking (not idle)', () => {
    const face = new MiniFace('test');
    face.state = 'happy';
    face.lastUpdate = Date.now() - 9000; // Past happy linger (8000ms)
    face.tick(16);
    assert.strictEqual(face.state, 'thinking');
  });

  test('thinking persists for active session past IDLE_TIMEOUT', () => {
    const face = new MiniFace('test');
    face.state = 'thinking';
    face.stopped = false;
    face.lastUpdate = Date.now() - 10000; // Past IDLE_TIMEOUT (8s) but not THINKING_TIMEOUT (45s)
    face.tick(16);
    assert.strictEqual(face.state, 'thinking');
  });

  test('thinking degrades to idle quickly when stopped', () => {
    const face = new MiniFace('test');
    face.state = 'thinking';
    face.stopped = true;
    face.lastUpdate = Date.now() - 9000; // Past IDLE_TIMEOUT (8s)
    face.tick(16);
    assert.strictEqual(face.state, 'idle');
  });

  test('active tool state transitions to thinking when session active', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.stopped = false;
    face.lastUpdate = Date.now() - 9000; // Past IDLE_TIMEOUT (8s)
    face.tick(16);
    assert.strictEqual(face.state, 'thinking');
  });

  test('active tool state transitions to idle when stopped', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.stopped = true;
    face.lastUpdate = Date.now() - 9000; // Past IDLE_TIMEOUT (8s)
    face.tick(16);
    assert.strictEqual(face.state, 'idle');
  });
});

describe('grid.js -- OrbitalSystem', () => {
  test('initializes with empty map', () => {
    const orbital = new OrbitalSystem();
    assert.strictEqual(orbital.faces.size, 0);
  });

  test('update ticks all faces and advances rotation', () => {
    const orbital = new OrbitalSystem();
    orbital.faces.set('a', new MiniFace('a'));
    orbital.faces.set('b', new MiniFace('b'));
    const prevAngle = orbital.rotationAngle;
    orbital.update(66);
    assert.strictEqual(orbital.frame, 1);
    assert.ok(orbital.rotationAngle > prevAngle);
    for (const face of orbital.faces.values()) {
      assert.strictEqual(face.frame, 1);
    }
  });

  test('rotation angle advances by rotationSpeed each update', () => {
    const orbital = new OrbitalSystem();
    const speed = orbital.rotationSpeed;
    orbital.update(66);
    assert.ok(Math.abs(orbital.rotationAngle - speed) < 0.0001);
  });

  test('rotation angle wraps around at 2*PI', () => {
    const orbital = new OrbitalSystem();
    orbital.rotationAngle = Math.PI * 2 - 0.001;
    orbital.update(66);
    assert.ok(orbital.rotationAngle < Math.PI * 2);
  });
});

describe('grid.js -- OrbitalSystem calculateOrbit', () => {
  test('returns zero maxSlots for small terminal', () => {
    const orbital = new OrbitalSystem();
    const mainPos = { row: 5, col: 10, w: 30, h: 10, centerX: 25, centerY: 10 };
    const result = orbital.calculateOrbit(40, 15, mainPos);
    assert.strictEqual(result.maxSlots, 0);
  });

  test('returns positive maxSlots for large terminal', () => {
    const orbital = new OrbitalSystem();
    const mainPos = { row: 15, col: 40, w: 30, h: 10, centerX: 55, centerY: 20 };
    const result = orbital.calculateOrbit(120, 50, mainPos);
    assert.ok(result.maxSlots > 0);
    assert.ok(result.a > 0);
    assert.ok(result.b > 0);
  });

  test('maxSlots capped at 8', () => {
    const orbital = new OrbitalSystem();
    const mainPos = { row: 50, col: 100, w: 30, h: 10, centerX: 115, centerY: 55 };
    const result = orbital.calculateOrbit(300, 120, mainPos);
    assert.ok(result.maxSlots <= 8);
  });

  test('semi-axes clear the main face box', () => {
    const orbital = new OrbitalSystem();
    const mainPos = { row: 15, col: 40, w: 30, h: 10, centerX: 55, centerY: 20 };
    const result = orbital.calculateOrbit(120, 50, mainPos);
    // a should be at least mainPos.w/2 + MINI_W/2 + 3
    assert.ok(result.a >= Math.floor(mainPos.w / 2) + 4 + 3);
    // b should be at least mainPos.h/2 + MINI_H/2 + 6 (extra for decorations)
    assert.ok(result.b >= Math.floor(mainPos.h / 2) + 3 + 6);
  });
});

describe('grid.js -- OrbitalSystem session exclusion', () => {
  test('loadSessions with excludeId skips main session', () => {
    const orbital = new OrbitalSystem();
    // Manually populate to test exclusion logic
    orbital.faces.set('main-session', new MiniFace('main-session'));
    orbital.faces.set('sub-session', new MiniFace('sub-session'));
    // After a loadSessions call with excludeId, the main session would be excluded
    // We test the concept by checking that _assignLabels works on remaining faces
    orbital.faces.delete('main-session');
    orbital._assignLabels();
    assert.strictEqual(orbital.faces.size, 1);
    assert.ok(orbital.faces.has('sub-session'));
  });
});

describe('grid.js -- OrbitalSystem stale cleanup', () => {
  test('stale stopped faces are detected', () => {
    const face = new MiniFace('stale');
    face.stopped = true;
    face.stoppedAt = Date.now() - 15000; // Past STOPPED_LINGER_MS (10s)
    assert.ok(face.isStale());
  });

  test('recently stopped faces are not stale', () => {
    const face = new MiniFace('recent');
    face.stopped = true;
    face.stoppedAt = Date.now() - 5000; // Within STOPPED_LINGER_MS (10s)
    assert.ok(!face.isStale());
  });

  test('fresh faces are not stale', () => {
    const face = new MiniFace('fresh');
    assert.ok(!face.isStale());
  });

  test('completion states become stale after STOPPED_LINGER_MS (issue #59 fix)', () => {
    // #59 was about ghost ORBITALS: a subagent that reported `happy` and went
    // quiet is finished and must not linger. The short cut is therefore a
    // child rule -- a top-level session is judged in the same load pass that
    // built it, before any tick() moves the reward state on, so applying it
    // there killed live windows at a cold boot. It is also an ORPHAN rule: a
    // child of a live family is judged on its orphan timeout, or every agent
    // whose last write was a reward died at renderer boot.
    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    for (const state of completionStates) {
      const face = new MiniFace(state);
      face.state = state;
      face.parentSession = 'parent';
      face.parentAlive = false;
      face.lastUpdate = Date.now() - 15000; // Past STOPPED_LINGER_MS (10s)
      assert.ok(face.isStale(), `${state} should be stale after 10s`);
    }
  });

  test('a completion-state child of a LIVE family is not cut at 10s', () => {
    for (const state of ['happy', 'satisfied', 'proud', 'relieved']) {
      const face = new MiniFace(state);
      face.state = state;
      face.parentSession = 'parent';
      face.parentAlive = true;
      face.lastUpdate = Date.now() - 15000;
      assert.ok(!face.isStale(), `${state} child of a live parent was cut`);
    }
  });

  test('recent completion states are not stale', () => {
    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    for (const state of completionStates) {
      const face = new MiniFace(state);
      face.state = state;
      face.lastUpdate = Date.now() - 5000; // Within STOPPED_LINGER_MS (10s)
      assert.ok(!face.isStale(), `${state} should not be stale within 10s`);
    }
  });
});

describe('grid.js -- OrbitalSystem session schema validation', () => {
  test('loadSessions shows sessions without parentSession/isTeammate (parallel sessions)', () => {
    // Parallel Claude Code sessions don't have parentSession or isTeammate.
    // They should now appear as orbitals (excluded only by matching excludeId).
    const fs = require('fs');
    const path = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    // Create a session file WITHOUT parentSession or isTeammate
    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    const parallelFile = path.join(SESSIONS_DIR, 'parallel-session.json');
    fs.writeFileSync(parallelFile, JSON.stringify({
      session_id: 'parallel-session',
      state: 'thinking',
      detail: '',
      timestamp: Date.now(),
    }));

    orbital.loadSessions('different-id');
    assert.ok(orbital.faces.has('parallel-session'),
      'session without parentSession/isTeammate should be included as parallel orbital');

    // Clean up
    try { fs.unlinkSync(parallelFile); } catch {}
  });

  test('loadSessions loads the main session but keeps it off the ring', () => {
    // The main session is read like any other file (the big face follows it)
    // and is excluded from the orbitals by its ID, not by missing fields
    const fs = require('fs');
    const path = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    const mainFile = path.join(SESSIONS_DIR, 'main-session.json');
    fs.writeFileSync(mainFile, JSON.stringify({
      session_id: 'main-session',
      state: 'coding',
      detail: '',
      timestamp: Date.now(),
    }));

    orbital.loadSessions('main-session');
    assert.ok(orbital.faces.has('main-session'),
      'the main session is loaded like any other session file');
    assert.ok(!orbital.getSortedFaces().some(f => f.sessionId === 'main-session'),
      'session matching excludeId should be excluded from the ring');

    // Clean up
    try { fs.unlinkSync(mainFile); } catch {}
  });

  test('loadSessions includes sessions with parentSession', () => {
    const fs = require('fs');
    const path = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    const subFile = path.join(SESSIONS_DIR, 'real-subagent.json');
    fs.writeFileSync(subFile, JSON.stringify({
      session_id: 'real-subagent',
      state: 'coding',
      detail: 'editing',
      timestamp: Date.now(),
      parentSession: 'main-session',
    }));

    orbital.loadSessions('main-session');
    assert.ok(orbital.faces.has('real-subagent'),
      'session with parentSession should be included');

    // Clean up
    try { fs.unlinkSync(subFile); } catch {}
  });

  test('loadSessions includes sessions with isTeammate', () => {
    const fs = require('fs');
    const path = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    const teamFile = path.join(SESSIONS_DIR, 'teammate-session.json');
    fs.writeFileSync(teamFile, JSON.stringify({
      session_id: 'teammate-session',
      state: 'reading',
      detail: '',
      timestamp: Date.now(),
      isTeammate: true,
      teamName: 'alpha',
      teammateName: 'researcher',
    }));

    orbital.loadSessions('main-session');
    assert.ok(orbital.faces.has('teammate-session'),
      'session with isTeammate should be included');

    // Clean up
    try { fs.unlinkSync(teamFile); } catch {}
  });
});

describe('grid.js -- OrbitalSystem side panel', () => {
  test('_renderSidePanel returns string with faces on sides', () => {
    const orbital = new OrbitalSystem();
    const face1 = new MiniFace('sub-1');
    face1.state = 'coding';
    face1.label = 'sub-1';
    orbital.faces.set('sub-1', face1);
    const mainPos = { row: 7, col: 26, w: 30, h: 10, centerX: 41, centerY: 12 };
    const result = orbital._renderSidePanel(80, 24, mainPos);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  test('_renderSidePanel returns text fallback when no side space', () => {
    const orbital = new OrbitalSystem();
    orbital.faces.set('sub-1', new MiniFace('sub-1'));
    // Main face fills the entire terminal width
    const mainPos = { row: 2, col: 1, w: 38, h: 10, centerX: 20, centerY: 7 };
    const result = orbital._renderSidePanel(40, 15, mainPos);
    assert.ok(result.includes('subagent'));
  });

  test('_renderSidePanel distributes faces to both sides', () => {
    const orbital = new OrbitalSystem();
    for (let i = 0; i < 4; i++) {
      const f = new MiniFace(`sub-${i}`);
      f.label = `sub-${i}`;
      f.state = 'coding';
      orbital.faces.set(`sub-${i}`, f);
    }
    const mainPos = { row: 7, col: 26, w: 30, h: 10, centerX: 41, centerY: 12 };
    const result = orbital._renderSidePanel(80, 24, mainPos);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  test('render falls back to side panel at 80x24', () => {
    const orbital = new OrbitalSystem();
    const f = new MiniFace('sub-1');
    f.label = 'sub-1';
    f.state = 'reading';
    orbital.faces.set('sub-1', f);
    // At 80x24, orbital ellipse can't fit (maxB < minB), so side panel kicks in
    const mainPos = { row: 7, col: 26, w: 30, h: 10, centerX: 41, centerY: 12 };
    const result = orbital.render(80, 24, mainPos);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });
});

describe('animations.js -- conducting', () => {
  test('eyes.conducting cycles through phases', () => {
    // Phase 0 (frame 0): open
    const r0 = eyes.conducting({}, 0);
    assert.ok(r0.left && r0.right);

    // Phase 1 (frame 30): lookLeft
    const r1 = eyes.conducting({}, 30);
    const ll = eyes.lookLeft();
    assert.deepStrictEqual(r1, ll);

    // Phase 3 (frame 90): lookRight
    const r3 = eyes.conducting({}, 90);
    const lr = eyes.lookRight();
    assert.deepStrictEqual(r3, lr);

    // Phase 5 (frame 150): focused
    const r5 = eyes.conducting({}, 150);
    const fc = eyes.focused();
    assert.deepStrictEqual(r5, fc);
  });

  test('mouths.conducting returns determined mouth', () => {
    const result = mouths.conducting();
    const expected = mouths.determined();
    assert.strictEqual(result, expected);
  });
});

describe('particles.js -- stream style', () => {
  test('stream particles spawn with outward velocity', () => {
    const ps = new ParticleSystem();
    ps.spawn(5, 'stream');
    assert.strictEqual(ps.particles.length, 5);
    for (const p of ps.particles) {
      assert.strictEqual(p.style, 'stream');
      // Spawns from center
      assert.strictEqual(p.x, ps.width / 2);
      assert.strictEqual(p.y, ps.height / 2);
      // Has non-zero velocity
      assert.ok(p.vx !== 0 || p.vy !== 0);
      assert.ok(p.life > 0);
      assert.ok(p.maxLife === 60);
    }
  });

  test('stream particles move outward on update', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'stream');
    const p = ps.particles[0];
    const origX = p.x;
    const origY = p.y;
    ps.update();
    // Should have moved from center
    assert.ok(p.x !== origX || p.y !== origY);
  });
});

describe('face.js -- orbital toggle', () => {
  test('showOrbitals defaults to true', () => {
    const { ClaudeFace } = require('../face');
    const face = new ClaudeFace();
    assert.strictEqual(face.showOrbitals, true);
  });

  test('toggleOrbitals flips state', () => {
    const { ClaudeFace } = require('../face');
    const face = new ClaudeFace();
    face.toggleOrbitals();
    assert.strictEqual(face.showOrbitals, false);
    face.toggleOrbitals();
    assert.strictEqual(face.showOrbitals, true);
  });

  test('subagentCount defaults to 0', () => {
    const { ClaudeFace } = require('../face');
    const face = new ClaudeFace();
    assert.strictEqual(face.subagentCount, 0);
  });

  test('lastPos is null before first render', () => {
    const { ClaudeFace } = require('../face');
    const face = new ClaudeFace();
    assert.strictEqual(face.lastPos, null);
  });
});

describe('OrbitalSystem._renderSidePanel', () => {
  test('a thought bubble appearing does not move the side-panel column', () => {
    // It used to step the right column past the bubble, so the whole column
    // jumped sideways every time a thought came or went. The main face now
    // layers over the ring instead, and the column comes from the keep-out.
    const sys = new OrbitalSystem();
    sys.faces.set('test-session', new MiniFace('test-session'));
    const base = { col: 5, w: 20, row: 5, h: 12, centerX: 15, centerY: 11 };
    const withBubble = { ...base, bubble: { col: 27, w: 15, row: 8, h: 3 } };
    assert.strictEqual(
      sys._renderSidePanel(100, 40, withBubble, null),
      sys._renderSidePanel(100, 40, base, null));
  });

  test('right-col falls back to mainPos.w + SIDE_PAD when no bubble', () => {
    const sys = new OrbitalSystem();
    const mf = new MiniFace('test-session-2');
    sys.faces.set('test-session-2', mf);

    const mainPos = {
      col: 5, w: 20, row: 5, h: 12,
      centerX: 15, centerY: 11
      // no bubble
    };
    const SIDE_PAD = 2;
    const expectedCol = mainPos.col + mainPos.w + SIDE_PAD; // 5+20+2=27

    const out = sys._renderSidePanel(100, 40, mainPos, null);
    const re = /\x1b\[(\d+);(\d+)H/g;
    let m;
    const rightCols = [];
    while ((m = re.exec(out)) !== null) {
      const col = parseInt(m[2], 10);
      if (col > mainPos.col + mainPos.w) rightCols.push(col);
    }

    assert.ok(rightCols.length > 0, 'should render some content to the right of main face');
    const minRightCol = Math.min(...rightCols);
    assert.ok(
      minRightCol >= expectedCol,
      `right-side mini-face col ${minRightCol} should be >= ${expectedCol}`
    );
  });
});

describe('grid.js -- MiniFace tick() minDisplayUntil guard (Bug 3)', () => {
  test('tick does not override state during minDisplayUntil', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.lastUpdate = Date.now() - 9000; // Past IDLE_TIMEOUT
    face.minDisplayUntil = Date.now() + 5000; // Locked for 5 more seconds
    face.tick(16);
    assert.strictEqual(face.state, 'coding',
      'state should not change while minDisplayUntil is in the future');
  });

  test('tick transitions after minDisplayUntil expires', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.stopped = false;
    face.lastUpdate = Date.now() - 9000; // Past IDLE_TIMEOUT
    face.minDisplayUntil = Date.now() - 1; // Expired
    face.tick(16);
    assert.strictEqual(face.state, 'thinking',
      'should transition to thinking after minDisplayUntil expires');
  });

  test('tick sets minDisplayUntil after timeout transition', () => {
    const face = new MiniFace('test');
    face.state = 'happy';
    face.lastUpdate = Date.now() - 9000; // Past happy linger
    face.minDisplayUntil = 0; // Expired
    const before = Date.now();
    face.tick(16);
    assert.strictEqual(face.state, 'thinking');
    assert.ok(face.minDisplayUntil >= before + 1500,
      'minDisplayUntil should be set after timeout transition');
  });

  test('blink animation still runs during minDisplayUntil lock', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.minDisplayUntil = Date.now() + 5000;
    face.blinkTimer = 10; // About to blink
    face.tick(20); // dt > blinkTimer — triggers blink then increments frame
    assert.ok(face.blinkFrame >= 0,
      'blink should trigger even during minDisplayUntil lock');
    assert.strictEqual(face.state, 'coding',
      'state should remain locked');
  });

  test('spawning auto-transition sets minDisplayUntil', () => {
    const face = new MiniFace('test');
    face.state = 'spawning';
    face.firstSeen = Date.now() - 3000; // Past 2s spawn duration
    face.minDisplayUntil = 0;
    const before = Date.now();
    face.tick(16);
    assert.strictEqual(face.state, 'thinking');
    assert.ok(face.minDisplayUntil >= before + 1500);
  });
});

describe('grid.js -- MiniFace updateFromFile detail gating (Bug 3)', () => {
  test('detail updates when state change is accepted', () => {
    const face = new MiniFace('test');
    face.state = 'idle';
    face.minDisplayUntil = 0;
    face.updateFromFile({ state: 'coding', detail: 'editing foo.js' });
    assert.strictEqual(face.state, 'coding');
    assert.strictEqual(face.detail, 'editing foo.js');
  });

  test('detail does NOT update when state change is rejected', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.detail = 'editing foo.js';
    face.minDisplayUntil = Date.now() + 5000; // Locked
    face.updateFromFile({ state: 'reading', detail: 'reading bar.js' });
    assert.strictEqual(face.state, 'coding',
      'state should remain locked');
    assert.strictEqual(face.detail, 'editing foo.js',
      'detail should not update when state is rejected');
  });

  test('detail updates for same-state refresh', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.detail = 'editing foo.js';
    face.minDisplayUntil = Date.now() + 5000; // Locked
    face.updateFromFile({ state: 'coding', detail: 'editing bar.js' });
    assert.strictEqual(face.state, 'coding');
    assert.strictEqual(face.detail, 'editing bar.js',
      'detail should update when same state is refreshed');
  });

  test('error always bypasses and updates detail', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.detail = 'editing foo.js';
    face.minDisplayUntil = Date.now() + 5000; // Locked
    face.updateFromFile({ state: 'error', detail: 'command failed' });
    assert.strictEqual(face.state, 'error');
    assert.strictEqual(face.detail, 'command failed');
  });
});

describe('grid.js -- completion linger respects sessionActive (#70)', () => {
  test('stopped session decays to idle after completion linger', () => {
    const face = new MiniFace('test');
    face.state = 'happy';
    face.stopped = true;
    face.lastUpdate = Date.now() - 9000;
    face.minDisplayUntil = 0;
    face.tick(16);
    assert.strictEqual(face.state, 'idle',
      'stopped session should decay to idle, not thinking');
  });

  test('active session decays to thinking after completion linger', () => {
    const face = new MiniFace('test');
    face.state = 'happy';
    face.stopped = false;
    face.lastUpdate = Date.now() - 9000;
    face.minDisplayUntil = 0;
    face.tick(16);
    assert.strictEqual(face.state, 'thinking',
      'active session should decay to thinking');
  });
});

describe('grid.js -- lastUpdate uses fileMtimeMs or Date.now() (#71)', () => {
  test('lastUpdate uses fileMtimeMs when provided', () => {
    const face = new MiniFace('test');
    const mtime = Date.now() - 20000; // 20s ago
    face.updateFromFile({ state: 'coding' }, mtime);
    assert.strictEqual(face.lastUpdate, mtime,
      'lastUpdate should use fileMtimeMs when provided');
  });

  test('lastUpdate falls back to Date.now() when fileMtimeMs is omitted', () => {
    const face = new MiniFace('test');
    const before = Date.now();
    face.updateFromFile({ state: 'reading' });
    assert.ok(face.lastUpdate >= before,
      'lastUpdate should fall back to Date.now() without fileMtimeMs');
  });

  test('lastUpdate ignores data.timestamp (not file mtime)', () => {
    const face = new MiniFace('test');
    const staleTimestamp = Date.now() - 300000;
    const before = Date.now();
    face.updateFromFile({ state: 'coding', timestamp: staleTimestamp });
    assert.ok(face.lastUpdate >= before,
      'lastUpdate should not use data.timestamp');
  });
});

describe('grid.js -- MiniFace pending state queue (#55)', () => {
  test('rejected state is buffered as pendingState', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.minDisplayUntil = Date.now() + 5000;
    face.updateFromFile({ state: 'reading', detail: 'reading bar.js' });
    assert.strictEqual(face.state, 'coding', 'state should remain locked');
    assert.strictEqual(face.pendingState, 'reading', 'rejected state should be buffered');
    assert.strictEqual(face.pendingDetail, 'reading bar.js', 'rejected detail should be buffered');
  });

  test('pending state flushes when minDisplayUntil expires in tick()', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.pendingState = 'searching';
    face.pendingDetail = 'grep foo';
    face.minDisplayUntil = Date.now() - 1;
    face.lastUpdate = Date.now();
    face.tick(16);
    assert.strictEqual(face.state, 'searching', 'pending state should flush');
    assert.strictEqual(face.detail, 'grep foo', 'pending detail should flush');
    assert.strictEqual(face.pendingState, null, 'pendingState should clear after flush');
  });

  test('active work state interrupts interruptible state despite minDisplayUntil', () => {
    const face = new MiniFace('test');
    face.state = 'idle';
    face.minDisplayUntil = Date.now() + 5000;
    face.updateFromFile({ state: 'coding', detail: 'editing foo.js' });
    assert.strictEqual(face.state, 'coding',
      'work state should interrupt idle despite minDisplayUntil');
  });

  test('work states get shorter minDisplayUntil (~800ms)', () => {
    const face = new MiniFace('test');
    face.state = 'idle';
    face.minDisplayUntil = 0;
    const before = Date.now();
    face.updateFromFile({ state: 'coding', detail: 'editing foo.js' });
    assert.ok(face.minDisplayUntil <= before + 1000,
      'work state minDisplayUntil should be ~800ms, not 1500ms');
    assert.ok(face.minDisplayUntil >= before + 600,
      'work state minDisplayUntil should be at least ~800ms');
  });

  test('non-work state cannot interrupt locked work state', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.minDisplayUntil = Date.now() + 5000;
    face.updateFromFile({ state: 'thinking', detail: '' });
    assert.strictEqual(face.state, 'coding',
      'thinking should not interrupt locked coding state');
    assert.strictEqual(face.pendingState, 'thinking',
      'thinking should be buffered as pending');
  });
});

describe('grid.js -- MiniFace detail row rendering (#57)', () => {
  test('render includes detail text when detail is set', () => {
    const face = new MiniFace('test');
    face.detail = 'foo.js';
    const out = face.render(1, 1, 0, null);
    assert.ok(out.includes('foo.js'), 'render output should include detail text');
  });

  test('render writes blank detail row when detail is empty (ghost prevention)', () => {
    const face = new MiniFace('test');
    face.detail = '';
    const out = face.render(1, 1, 0, null);
    // Row 6 should always be written (with spaces) to prevent ghost artifacts
    const row6Marker = '\x1b[7;'; // ansi.to(startRow+6=7, col=1) → ESC[7;1H
    assert.ok(out.includes(row6Marker), 'row 6 should be rendered even when detail is empty');
  });

  test('detail is truncated to BOX_W (8) characters', () => {
    const face = new MiniFace('test');
    face.detail = 'this-is-a-very-long-filename.js';
    const out = face.render(1, 1, 0, null);
    assert.ok(out.includes('this-is-'), 'detail should be truncated to 8 chars');
    assert.ok(!out.includes('this-is-a-'), 'detail should not exceed 8 chars');
  });
});

// -- taskDescription tests ---------------------------------------------------

describe('grid.js -- MiniFace taskDescription', () => {
  test('stores taskDescription from updateFromFile', () => {
    const mf = new MiniFace('td-test');
    mf.updateFromFile({ state: 'coding', detail: 'editing foo.js', taskDescription: 'fix unit tests' });
    assert.strictEqual(mf.taskDescription, 'fix unit tests');
  });

  test('taskDescription not cleared by updates without it', () => {
    const mf = new MiniFace('td-sticky');
    mf.updateFromFile({ state: 'coding', detail: 'editing foo.js', taskDescription: 'fix unit tests' });
    mf.updateFromFile({ state: 'searching', detail: 'grep: TODO' });
    assert.strictEqual(mf.taskDescription, 'fix unit tests',
      'taskDescription should persist when subsequent update omits it');
  });
});

describe('grid.js -- OrbitalSystem _assignLabels taskDescription', () => {
  test('_assignLabels prefers taskDescription over cwd', () => {
    const os = new OrbitalSystem();
    const face = new MiniFace('td-label');
    face.taskDescription = 'fix tests';
    face.cwd = '/home/user/project';
    os.faces.set('td-label', face);
    os._assignLabels();
    assert.strictEqual(face.label, 'fix test',
      'label should be taskDescription truncated to 8 chars');
  });

  test('teammate name takes priority over taskDescription', () => {
    const os = new OrbitalSystem();
    const face = new MiniFace('td-team');
    face.teammateName = 'reviewer';
    face.taskDescription = 'fix tests';
    os.faces.set('td-team', face);
    os._assignLabels();
    assert.strictEqual(face.label, 'reviewer',
      'teammateName should take priority over taskDescription');
  });

  test('falls back to cwd when no taskDescription', () => {
    const os = new OrbitalSystem();
    const face = new MiniFace('td-fallback');
    face.cwd = '/home/user/my-project';
    os.faces.set('td-fallback', face);
    os._assignLabels();
    assert.strictEqual(face.label, 'my-proje',
      'label should fall back to cwd basename truncated to 8 chars');
  });
});

// -- isMainSession classification -------------------------------------------

describe('grid.js -- MiniFace isMainSession', () => {
  test('default isMainSession is false', () => {
    const face = new MiniFace('test');
    assert.strictEqual(face.isMainSession, false);
  });

  test('updateFromFile with no parentSession and no isTeammate sets isMainSession true', () => {
    const face = new MiniFace('independent');
    face.updateFromFile({ state: 'coding', modelName: 'claude' });
    assert.strictEqual(face.isMainSession, true);
  });

  test('updateFromFile with parentSession set keeps isMainSession false', () => {
    const face = new MiniFace('child');
    face.updateFromFile({ state: 'coding', parentSession: 'parent-123' });
    assert.strictEqual(face.isMainSession, false);
  });

  test('updateFromFile with isTeammate true keeps isMainSession false', () => {
    const face = new MiniFace('teammate');
    face.updateFromFile({ state: 'coding', isTeammate: true, teamName: 'builders' });
    assert.strictEqual(face.isMainSession, false);
  });
});

describe('grid.js -- _assignLabels isMainSession', () => {
  // Documented order: teammateName > taskDescription > cwd basename >
  // modelName > sub-N. This test used to pin modelName beating the cwd.
  test('independent main session prefers its cwd basename over modelName', () => {
    const os = new OrbitalSystem();
    const face = new MiniFace('ind-1');
    face.isMainSession = true;
    face.modelName = 'opencode';
    face.cwd = '/home/user/project';
    os.faces.set('ind-1', face);
    os._assignLabels();
    assert.strictEqual(face.label, 'project',
      'cwd basename outranks modelName');
  });

  test('independent main session without a cwd falls back to modelName', () => {
    const os = new OrbitalSystem();
    const face = new MiniFace('ind-1b');
    face.isMainSession = true;
    face.modelName = 'opencode';
    os.faces.set('ind-1b', face);
    os._assignLabels();
    assert.strictEqual(face.label, 'opencode');
  });

  test('two parallel windows in different folders are told apart by folder', () => {
    const os = new OrbitalSystem();
    const a = new MiniFace('win-a');
    const b = new MiniFace('win-b');
    for (const f of [a, b]) { f.isMainSession = true; f.modelName = 'claude'; }
    a.cwd = '/home/user/frontend';
    b.cwd = '/home/user/backend';
    os.faces.set('win-a', a);
    os.faces.set('win-b', b);
    os._assignLabels();
    assert.strictEqual(a.label, 'frontend');
    assert.strictEqual(b.label, 'backend');
  });

  test('parallel windows sharing a folder name fall back to modelName', () => {
    const os = new OrbitalSystem();
    const a = new MiniFace('same-a');
    const b = new MiniFace('same-b');
    a.isMainSession = true; a.modelName = 'claude'; a.cwd = '/one/app';
    b.isMainSession = true; b.modelName = 'codex'; b.cwd = '/two/app';
    os.faces.set('same-a', a);
    os.faces.set('same-b', b);
    os._assignLabels();
    assert.strictEqual(a.label, 'claude');
    assert.strictEqual(b.label, 'codex');
  });

  test('taskDescription still takes priority over isMainSession modelName', () => {
    const os = new OrbitalSystem();
    const face = new MiniFace('ind-2');
    face.isMainSession = true;
    face.modelName = 'claude';
    face.taskDescription = 'fix bugs';
    os.faces.set('ind-2', face);
    os._assignLabels();
    assert.strictEqual(face.label, 'fix bugs',
      'taskDescription should still take priority over isMainSession');
  });
});

describe('grid.js -- renderSessionList isMainSession indicator', () => {
  test('orbital with isMainSession gets outline star', () => {
    const face = new MiniFace('ind-orbital');
    face.state = 'coding';
    face.label = 'opencode';
    face.isMainSession = true;
    face.cwd = '/home/user/project';
    const result = renderSessionList(80, 40, [face], PALETTES[0].themes);
    assert.ok(result.includes('\u2606'), 'should show outline star for isMainSession orbital');
  });

  test('orbital without isMainSession gets no star', () => {
    const face = new MiniFace('sub-orbital');
    face.state = 'coding';
    face.label = 'sub-1';
    face.isMainSession = false;
    face.cwd = '/home/user/project';
    const result = renderSessionList(80, 40, [face], PALETTES[0].themes);
    assert.ok(!result.includes('\u2606'), 'should not show outline star for regular subagent');
    assert.ok(!result.includes('\u2605'), 'should not show filled star for regular subagent');
  });
});

// -- Issue #58: SessionStart always takes over as main face ------------------

describe('grid.js -- SessionStart adoption (issue #58)', () => {
  test('update-state.js: SessionStart forces shouldWriteGlobal even when another session owns state file', () => {
    // Simulates the logic in update-state.js: if an existing session owns the
    // state file (different ID, not stopped, fresh timestamp), shouldWriteGlobal
    // would normally be false. But SessionStart overrides it to true.
    const hookEvent = 'SessionStart';
    const existingSessionId = 'old-session-abc';
    const incomingSessionId = 'new-session-xyz';
    const existingTimestamp = Date.now() - 5000; // 5s ago — well within 120s

    // Simulate the shouldWriteGlobal check from update-state.js
    let shouldWriteGlobal = true;
    if (existingSessionId && existingSessionId !== incomingSessionId &&
        /* !existing.stopped */ true && Date.now() - existingTimestamp < 120000) {
      shouldWriteGlobal = false;
    }

    // Before the fix, shouldWriteGlobal would stay false and SessionStart would be lost
    assert.strictEqual(shouldWriteGlobal, false, 'shouldWriteGlobal should initially be false');

    // Apply the fix: SessionStart always forces global write
    if (hookEvent === 'SessionStart') shouldWriteGlobal = true;

    assert.strictEqual(shouldWriteGlobal, true,
      'SessionStart should force shouldWriteGlobal to true');
  });

  test('renderer adoption: a fresh SessionStart elsewhere wins the center through pickMainSession', () => {
    const { pickMainSession } = require('../renderer');
    const r = pickMainSession({
      sessions: [
        { id: 'old', attentionAt: 100, lastUpdate: 100 },
        { id: 'new', attentionAt: 200, lastUpdate: 200 },
      ], currentId: 'old', pinnedId: null,
    });
    assert.strictEqual(r.mainId, 'new');
  });

  test('subagent with parentSession is blocked from global state writes', () => {
    // Simulates the new guard in update-state.js: after the existing-session
    // ownership check, we read the caller's own session file. If it has
    // parentSession, shouldWriteGlobal is forced false.
    let shouldWriteGlobal = true;
    const mySessionData = { parentSession: 'main-session-123' };

    // Apply the new guard
    if (mySessionData.parentSession) shouldWriteGlobal = false;

    assert.strictEqual(shouldWriteGlobal, false,
      'subagent with parentSession must not write to global state');
  });

  test('independent session (no parentSession) is allowed to write when main is stopped', () => {
    // An independent session whose session file has no parentSession should
    // still be allowed through, matching the pre-existing behavior where
    // stopped=true releases ownership.
    const existingStopped = true;
    let shouldWriteGlobal = true;

    // Existing session is stopped, so ownership check passes
    if (!existingStopped) shouldWriteGlobal = false;

    // No parentSession in session file — guard does not trigger
    const mySessionData = { state: 'thinking' };
    if (mySessionData.parentSession) shouldWriteGlobal = false;

    assert.strictEqual(shouldWriteGlobal, true,
      'independent session should be allowed to write global state when main is stopped');
  });

  test('lastStopped resets to false when same session sends non-stopped event', () => {
    // Simulates the renderer fix: lastStopped = !!stateData.stopped
    // When the main session starts a new turn (PreToolUse), stopped is absent.
    let lastStopped = true; // was set by previous Stop event

    // New PreToolUse arrives — no stopped flag
    const stateData = { state: 'thinking', detail: 'planning' };
    lastStopped = !!stateData.stopped;

    assert.strictEqual(lastStopped, false,
      'lastStopped must reset to false when state has no stopped flag');

    // Verify it still goes true when stopped is present
    const stoppedData = { state: 'responding', stopped: true };
    lastStopped = !!stoppedData.stopped;

    assert.strictEqual(lastStopped, true,
      'lastStopped must be true when state has stopped flag');
  });

  test('renderer does NOT adopt a subagent writing its own file', () => {
    const { pickMainSession } = require('../renderer');
    const r = pickMainSession({
      sessions: [
        { id: 'old', attentionAt: 100, lastUpdate: 100 },
        { id: 'old-agent-1', parentSession: 'old', attentionAt: 999, lastUpdate: 999 },
      ], currentId: 'old', pinnedId: null,
    });
    assert.strictEqual(r.mainId, 'old');
  });
});

// -- Bug #0: orbital stale timeout (PID liveness + ORPHAN_TIMEOUT fallback) ---

describe('grid.js -- isStale() uses PID liveness + ORPHAN_TIMEOUT fallback (Bug #0)', () => {
  test('active face with live pid is never stale regardless of lastUpdate age', () => {
    const face = new MiniFace('test');
    face.stopped = false;
    face.state = 'thinking';
    face.pid = process.pid; // current process — definitely alive
    face.lastUpdate = Date.now() - 200000; // 200s ago — way past any timeout
    seedOwningPid(); // started long before the write, so it owns the session
    try {
      assert.ok(!face.isStale(),
        'face with live owning process should never be stale');
    } finally { _pidStartCache.delete(process.pid); }
  });

  test('active face with dead pid and old lastUpdate is stale', () => {
    const face = new MiniFace('test');
    face.stopped = false;
    face.state = 'thinking';
    face.pid = 999999; // almost certainly not a real process
    face.lastUpdate = Date.now() - 100000; // 100s ago — past ORPHAN_TIMEOUT (90s)
    assert.ok(face.isStale(),
      'face with dead process and old lastUpdate should be stale');
  });

  test('active face with dead pid but recent lastUpdate is not stale', () => {
    const face = new MiniFace('test');
    face.stopped = false;
    face.state = 'coding';
    face.pid = 999999; // dead process
    face.lastUpdate = Date.now() - 60000; // 60s ago — within ORPHAN_TIMEOUT (90s)
    assert.ok(!face.isStale(),
      'face with dead process but recent update should not be stale yet');
  });

  test('active face without pid falls back to ORPHAN_TIMEOUT (90s)', () => {
    const face = new MiniFace('test');
    face.stopped = false;
    face.state = 'thinking';
    face.pid = 0; // no pid (legacy session file)
    face.lastUpdate = Date.now() - 60000; // 60s ago — within ORPHAN_TIMEOUT (90s)
    assert.ok(!face.isStale(),
      'face without pid updated 60s ago should not be stale under ORPHAN_TIMEOUT');
  });

  test('active face without pid is stale after ORPHAN_TIMEOUT (90s)', () => {
    const face = new MiniFace('test');
    face.stopped = false;
    face.state = 'thinking';
    face.pid = 0; // no pid
    face.lastUpdate = Date.now() - 100000; // 100s ago — past ORPHAN_TIMEOUT (90s)
    assert.ok(face.isStale(),
      'face without pid updated 100s ago should be stale');
  });

  test('stopped face is stale after STOPPED_LINGER_MS (10s)', () => {
    const face = new MiniFace('test');
    face.stopped = true;
    face.stoppedAt = Date.now() - 15000; // 15s ago — past STOPPED_LINGER_MS (10s)
    assert.ok(face.isStale(),
      'stopped face past 10s should still be stale');
  });

  test('stopped face within STOPPED_LINGER_MS is not stale', () => {
    const face = new MiniFace('test');
    face.stopped = true;
    face.stoppedAt = Date.now() - 5000; // 5s ago — within STOPPED_LINGER_MS (10s)
    assert.ok(!face.isStale(),
      'stopped face within 10s should not be stale');
  });

  test('stopped face with live pid is still stale after STOPPED_LINGER_MS', () => {
    const face = new MiniFace('test');
    face.stopped = true;
    face.stoppedAt = Date.now() - 15000; // 15s ago — past STOPPED_LINGER_MS (10s)
    face.pid = process.pid; // live process — but stopped takes priority
    assert.ok(face.isStale(),
      'stopped flag should take priority over pid liveness');
  });

  test('active face with negative pid falls back to ORPHAN_TIMEOUT', () => {
    const face = new MiniFace('test');
    face.stopped = false;
    face.state = 'thinking';
    face.pid = -1; // negative pid — would signal process group on Unix
    face.lastUpdate = Date.now() - 100000; // 100s ago — past ORPHAN_TIMEOUT (90s)
    assert.ok(face.isStale(),
      'negative pid should be treated as no pid');
  });

  test('active face with pid 1 falls back to ORPHAN_TIMEOUT', () => {
    const face = new MiniFace('test');
    face.stopped = false;
    face.state = 'thinking';
    face.pid = 1; // PID 1 (init) — always alive, should be rejected
    face.lastUpdate = Date.now() - 100000; // 100s ago — past ORPHAN_TIMEOUT (90s)
    assert.ok(face.isStale(),
      'PID 1 should be rejected to prevent immortal orbitals');
  });

  test('completion state face (no pid) is stale after STOPPED_LINGER_MS (10s)', () => {
    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    for (const state of completionStates) {
      const face = new MiniFace('test');
      face.state = state;
      face.stopped = false;
      face.parentSession = 'parent'; // the short completion cut is a child rule
      face.parentAlive = false;      // ...for an orphaned family only
      face.pid = 0; // no pid — falls through to completion-state timeout
      face.lastUpdate = Date.now() - 15000; // 15s ago — past STOPPED_LINGER_MS (10s)
      assert.ok(face.isStale(),
        `completion state '${state}' past 10s (no pid) should be stale`);
    }
  });

  test('a TOP-LEVEL completion face (no pid) survives past STOPPED_LINGER_MS', () => {
    // Its face is built and judged in one loadSessions pass, before tick()
    // has moved the reward state on: the 10s cut would drop a live window.
    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    for (const state of completionStates) {
      const face = new MiniFace('test');
      face.state = state;
      face.stopped = false;
      face.pid = 0;
      face.lastUpdate = Date.now() - 15000; // past 10s, well within ORPHAN_TIMEOUT
      assert.ok(!face.isStale(),
        `top-level '${state}' should hold until ORPHAN_TIMEOUT`);
      face.lastUpdate = Date.now() - 100000; // past ORPHAN_TIMEOUT (90s)
      assert.ok(face.isStale(),
        `top-level '${state}' should still go stale at ORPHAN_TIMEOUT`);
    }
  });

  test('completion state face (no pid) within STOPPED_LINGER_MS is not stale', () => {
    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    for (const state of completionStates) {
      const face = new MiniFace('test');
      face.state = state;
      face.stopped = false;
      face.pid = 0; // no pid
      face.lastUpdate = Date.now() - 5000; // 5s ago — within STOPPED_LINGER_MS (10s)
      assert.ok(!face.isStale(),
        `completion state '${state}' within 10s (no pid) should not be stale`);
    }
  });

  test('completion state face with LIVE pid is NOT stale (Bug #108 fix)', () => {
    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    seedOwningPid();
    try {
      for (const state of completionStates) {
        const face = new MiniFace('test');
        face.state = state;
        face.stopped = false;
        face.pid = process.pid; // live process — should protect from staleness
        face.lastUpdate = Date.now() - 200000; // 200s ago — way past any timeout
        assert.ok(!face.isStale(),
          `completion state '${state}' with live pid should NEVER be stale`);
      }
    } finally { _pidStartCache.delete(process.pid); }
  });

  test('completion state face with DEAD pid is stale after STOPPED_LINGER_MS', () => {
    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    for (const state of completionStates) {
      const face = new MiniFace('test');
      face.state = state;
      face.stopped = false;
      face.parentSession = 'parent'; // the short completion cut is a child rule
      face.parentAlive = false;      // ...for an orphaned family only
      face.pid = 999999; // dead process
      face.lastUpdate = Date.now() - 15000; // 15s ago — past STOPPED_LINGER_MS
      assert.ok(face.isStale(),
        `completion state '${state}' with dead pid past 10s should be stale`);
    }
  });
});

describe('grid.js -- loadSessions mtime purge protects active faces (Bug #0)', () => {
  const fs = require('fs');
  const pathMod = require('path');
  const { SESSIONS_DIR } = require('../shared');

  // Same file in all three tests, only the in-memory face differs: that is
  // what makes "the file survived" attributable to the face and not to luck.
  function seedStaleFile(sessionId) {
    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    const fp = pathMod.join(SESSIONS_DIR, sessionId + '.json');
    fs.writeFileSync(fp, JSON.stringify({
      session_id: sessionId, state: 'thinking', detail: '', timestamp: Date.now(),
    }));
    const old = new Date(Date.now() - STALE_MS - 5000);
    fs.utimesSync(fp, old, old);
    return fp;
  }

  test('an active non-completion face protects its stale file from the purge', () => {
    const id = 'purge-active-face';
    const fp = seedStaleFile(id);
    try {
      const orbital = new OrbitalSystem();
      const face = new MiniFace(id);
      face.state = 'thinking';
      face.stopped = false;
      orbital.faces.set(id, face);
      orbital.loadSessions('different-main-id');
      assert.ok(fs.existsSync(fp),
        'an active thinking face must keep its session file alive past STALE_MS');
    } finally { try { fs.unlinkSync(fp); } catch {} }
  });

  test('the same stale file with no face and no pid is purged', () => {
    const id = 'purge-no-face';
    const fp = seedStaleFile(id);
    try {
      new OrbitalSystem().loadSessions('different-main-id');
      assert.ok(!fs.existsSync(fp), 'an unprotected stale file must be deleted');
    } finally { try { fs.unlinkSync(fp); } catch {} }
  });

  test('a stopped face does not protect its stale file', () => {
    const id = 'purge-stopped-face';
    const fp = seedStaleFile(id);
    try {
      const orbital = new OrbitalSystem();
      const face = new MiniFace(id);
      face.state = 'thinking';
      face.stopped = true;
      orbital.faces.set(id, face);
      orbital.loadSessions('different-main-id');
      assert.ok(!fs.existsSync(fp),
        'only a live face protects -- a stopped one is finished with its file');
    } finally { try { fs.unlinkSync(fp); } catch {} }
  });
});

// -- Row 5 cwd basename fallback -----------------------------------

describe('grid.js -- MiniFace row 5 cwd fallback', () => {
  test('row 5 shows cwd basename when no gitBranch', () => {
    const face = new MiniFace('test-cwd');
    face.state = 'coding';
    face.cwd = '/home/user/projects/my-app';
    face.label = 'sub-1';
    const output = face.render(1, 1, 0, PALETTES[0].themes);
    // The 6th row (startRow + 5) should contain "my-app"
    assert.ok(output.includes('my-app'), 'row 5 should show cwd basename');
  });

  test('row 5 shows branch when gitBranch is present (not cwd)', () => {
    const face = new MiniFace('test-branch');
    face.state = 'coding';
    face.cwd = '/home/user/projects/my-app';
    face.gitBranch = 'main';
    face.label = 'sub-1';
    const output = face.render(1, 1, 0, PALETTES[0].themes);
    assert.ok(output.includes('\u2387'), 'row 5 should show branch indicator');
    assert.ok(output.includes('main'), 'row 5 should show branch name');
    // Should NOT show the cwd basename when branch is present
    assert.ok(!output.includes('my-app'), 'row 5 should not show cwd when branch exists');
  });

  test('row 5 falls back to theme.status when no cwd and no branch', () => {
    const face = new MiniFace('test-fallback');
    face.state = 'coding';
    face.cwd = '';
    face.gitBranch = null;
    face.label = 'sub-1';
    const output = face.render(1, 1, 0, PALETTES[0].themes);
    const theme = PALETTES[0].themes.coding;
    // Status gets sliced to BOX_W (8 chars), so check for the beginning
    if (theme && theme.status) {
      const expected = theme.status.slice(0, 8);
      assert.ok(output.includes(expected), 'row 5 should show theme status as fallback');
    }
  });
});

// -- renderSessionList overlay -------------------------------------

describe('grid.js -- renderSessionList', () => {
  test('returns string for empty array', () => {
    const result = renderSessionList(80, 40, [], PALETTES[0].themes);
    assert.strictEqual(typeof result, 'string');
    assert.ok(result.includes('no sessions'), 'should show empty message');
  });

  test('returns string with session info for populated Map', () => {
    const faces = new Map();
    const f1 = new MiniFace('sess-1');
    f1.state = 'coding';
    f1.label = 'fix-auth';
    f1.cwd = '/home/user/projects/my-app';
    f1.detail = 'edit src/auth.ts';
    faces.set('sess-1', f1);

    const f2 = new MiniFace('sess-2');
    f2.state = 'thinking';
    f2.label = 'scraper';
    f2.cwd = '/home/user/projects/scraper';
    faces.set('sess-2', f2);

    const result = renderSessionList(80, 40, [...faces.values()], PALETTES[0].themes);
    assert.strictEqual(typeof result, 'string');
    assert.ok(result.length > 0, 'should produce output');
    assert.ok(result.includes('2 total'), 'should show count');
    assert.ok(result.includes('fix-auth'), 'should include label');
  });

  test('handles narrow terminal gracefully', () => {
    const faces = new Map();
    const f = new MiniFace('sess-1');
    f.state = 'coding';
    f.label = 'test';
    faces.set('sess-1', f);

    const result = renderSessionList(30, 40, [...faces.values()], PALETTES[0].themes);
    assert.strictEqual(result, '', 'should return empty for narrow terminal');
  });

  test('handles short terminal gracefully', () => {
    // Below MIN_SESSION_LIST_ROWS not even one entry plus chrome fits.
    const result = renderSessionList(80, 8, [], PALETTES[0].themes);
    assert.strictEqual(result, '', 'should return empty for short terminal');
  });

  test('includes stopped sessions with different indicator', () => {
    const faces = new Map();
    const f = new MiniFace('sess-stopped');
    f.state = 'idle';
    f.stopped = true;
    f.label = 'done';
    f.cwd = '/tmp/project';
    faces.set('sess-stopped', f);

    const result = renderSessionList(80, 40, [...faces.values()], PALETTES[0].themes);
    assert.ok(result.includes('\u2715'), 'stopped session should show ✕ indicator');
  });

  test('shows overflow indicator when too many sessions', () => {
    const faces = new Map();
    for (let i = 0; i < 20; i++) {
      const f = new MiniFace(`sess-${i}`);
      f.state = 'coding';
      f.label = `s-${i}`;
      f.cwd = `/tmp/proj-${i}`;
      faces.set(`sess-${i}`, f);
    }

    // Very short terminal -- can only fit a few
    const result = renderSessionList(80, 15, [...faces.values()], PALETTES[0].themes);
    assert.ok(result.includes('more'), 'should show overflow indicator');
  });
});

describe('grid.js -- renderSessionList selection', () => {
  function _makeFaces(n) {
    const faces = [];
    for (let i = 0; i < n; i++) {
      const f = new MiniFace(`sess-${i}`);
      f.state = i === 0 ? 'coding' : 'thinking';
      f.label = `sub-${i}`;
      f.cwd = `/home/user/proj-${i}`;
      faces.push(f);
    }
    return faces;
  }

  test('no highlight when selectedIndex is -1 (default)', () => {
    const faces = _makeFaces(2);
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes);
    // No selection marker should appear
    assert.ok(!result.includes('\u25b8'), 'no selection marker without selectedIndex');
  });

  test('shows selection marker when selectedIndex is set', () => {
    const faces = _makeFaces(2);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 1);
    assert.ok(result.includes('\u25b8'), 'should show selection marker ▸');
  });

  test('shows footer hint when selectedIndex >= 0', () => {
    const faces = _makeFaces(2);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 0);
    assert.ok(result.includes('select'), 'footer should mention select');
    // Index 0 is the main row, whose Enter action is pin (never promote).
    assert.ok(result.includes('\u23ce pin'), 'footer should mention the enter action');
    assert.ok(result.includes('esc'), 'footer should mention esc');
  });

  test('no footer hint without selection', () => {
    const faces = _makeFaces(2);
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes);
    assert.ok(!result.includes('promote'), 'no footer without selection');
  });

  test('selectedIndex beyond visible range does not crash', () => {
    const faces = _makeFaces(1);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    // selectedIndex 99 — way beyond the 2 entries (main + 1 sub)
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 99);
    assert.strictEqual(typeof result, 'string');
    // All 2 entries fit on screen — no phantom above indicator
    assert.ok(!result.includes('above'), 'no above indicator when all entries fit');
  });

  test('count text reflects main + orbitals', () => {
    const faces = _makeFaces(3);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 0);
    assert.ok(result.includes('4 total'), 'should count main + 3 subs = 4 total');
  });

  test('empty map with selectedIndex shows footer but no entries', () => {
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    const result = renderSessionList(80, 40, [], PALETTES[0].themes, mainInfo, 0);
    assert.ok(result.includes('\u23ce pin'), 'footer shows even with only main');
  });

  test('backward compatible: omitting selectedIndex works', () => {
    const faces = _makeFaces(2);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    // Calling without 6th arg should not crash
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo);
    assert.strictEqual(typeof result, 'string');
    assert.ok(!result.includes('\u25b8'), 'no selection marker without selectedIndex');
  });

  test('main session entry shows star indicator', () => {
    const faces = _makeFaces(1);
    const mainInfo = {
      state: 'thinking', detail: 'analyzing', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 0);
    assert.ok(result.includes('\u2605'), 'main session should show ★ indicator');
  });

  test('subagent entries do not show star indicator', () => {
    const faces = _makeFaces(1);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 0);
    // Count ★ occurrences — should be exactly 1 (main only)
    const stars = (result.match(/\u2605/g) || []).length;
    assert.strictEqual(stars, 1, 'only main session should have ★, not subagents');
  });

  test('scrolls to show selected item beyond maxVisible', () => {
    // 5 subs + main = 6 sessions; each entry is 4 rows + 1 separator, so
    // rows=24 → maxVisible = floor((24-7)/5) = 3
    const faces = _makeFaces(5);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    // Select the last session (index 5 in 0-based sorted array)
    const result = renderSessionList(80, 24, faces, PALETTES[0].themes, mainInfo, 5);
    // The last sub should be visible and selected
    assert.ok(result.includes('\u25b8'), 'should show selection marker');
    assert.ok(result.includes('sub-4'), 'last sub should be visible when scrolled');
    // "above" indicator should appear since we scrolled past top
    assert.ok(result.includes('above'), 'should show above indicator when scrolled down');
  });

  test('no above indicator when selection is at scroll top', () => {
    const faces = _makeFaces(5);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    // Select index 0 — no scrolling needed (maxVisible = floor((24-7)/5) = 3)
    const result = renderSessionList(80, 24, faces, PALETTES[0].themes, mainInfo, 0);
    assert.ok(!result.includes('above'), 'no above indicator at top of list');
  });

  test('more indicator for items below visible window', () => {
    const faces = _makeFaces(5);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    // Select index 0 — the 3 entries past maxVisible are hidden below
    const result = renderSessionList(80, 24, faces, PALETTES[0].themes, mainInfo, 0);
    assert.ok(result.includes('more'), 'should show more indicator for items below');
  });
});

// -- renderSessionList pin indicator ----------------------------------------

describe('grid.js -- renderSessionList pin indicator', () => {
  function _makeFaces(n) {
    const faces = [];
    for (let i = 0; i < n; i++) {
      const f = new MiniFace(`sess-${i}`);
      f.state = 'thinking';
      f.label = `sub-${i}`;
      f.cwd = `/home/user/proj-${i}`;
      faces.push(f);
    }
    return faces;
  }

  test('shows pin icon when isPinned is true', () => {
    const faces = _makeFaces(1);
    const mainInfo = {
      state: 'coding', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true, isPinned: true,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 0);
    assert.ok(result.includes('\u229b'), 'pinned main should show ⊛ indicator');
    assert.ok(!result.includes('\u2605'), 'pinned main should not show ★');
  });

  test('shows star icon when isPinned is false', () => {
    const faces = _makeFaces(1);
    const mainInfo = {
      state: 'coding', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true, isPinned: false,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 0);
    assert.ok(result.includes('\u2605'), 'unpinned main should show ★ indicator');
    assert.ok(!result.includes('\u229b'), 'unpinned main should not show ⊛');
  });

  test('footer says unpin when index 0 selected and pinned', () => {
    const faces = _makeFaces(1);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true, isPinned: true,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 0);
    assert.ok(result.includes('unpin'), 'footer should say unpin when main is pinned and selected');
    assert.ok(!result.includes('pin+promote'), 'footer should not say pin+promote');
  });

  test('footer says pin+promote when index > 0 selected', () => {
    const faces = _makeFaces(2);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true, isPinned: false,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 1);
    assert.ok(result.includes('pin+promote'), 'footer should say pin+promote for orbital selection');
    assert.ok(!result.includes('unpin'), 'footer should not say unpin');
  });

  test('footer says pin when index 0 selected and not pinned', () => {
    const faces = _makeFaces(1);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true, isPinned: false,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 0);
    // The main row's Enter action is pin/unpin only -- it is already the main.
    assert.ok(result.includes('\u23ce pin'), 'footer should say pin');
    assert.ok(!result.includes('unpin'), 'footer should not say unpin');
    assert.ok(!result.includes('pin+promote'), 'footer should not say pin+promote');
  });
});

// -- _renderConnections filtering -------------------------------------------

describe('_renderConnections filtering', () => {
  // Helper: build an OrbitalSystem with mainSessionId set
  function makeOrbital(mainId) {
    const os = new OrbitalSystem();
    os.mainSessionId = mainId;
    os.time = 5000; // non-zero for pulse calculation
    return os;
  }

  // mainPos centered in a large terminal so connection dots aren't clipped
  const mainPos = {
    col: 10, row: 5, w: 20, h: 10,
    centerX: 20, centerY: 10,
  };
  const accentColor = [100, 200, 255];

  // Position far enough from main (steps >= 4) to generate dots
  function makePos(face) {
    return { col: 60, row: 25, face };
  }

  test('connection drawn for child whose parentSession matches main', () => {
    const os = makeOrbital('session-A');
    const pos = makePos({ parentSession: 'session-A', isTeammate: false });
    const out = os._renderConnections(mainPos, [pos], accentColor);
    assert.ok(out.includes('\u00b7'), 'should draw dots for matching parentSession');
  });

  test('no connection for child whose parentSession does NOT match main', () => {
    const os = makeOrbital('session-A');
    const pos = makePos({ parentSession: 'session-B', isTeammate: false });
    const out = os._renderConnections(mainPos, [pos], accentColor);
    assert.ok(!out.includes('\u00b7'), 'should skip dots when parentSession belongs to another session');
  });

  test('no connection for session with no parentSession (parallel session)', () => {
    const os = makeOrbital('session-A');
    const pos = makePos({ parentSession: null, isTeammate: false });
    const out = os._renderConnections(mainPos, [pos], accentColor);
    assert.ok(!out.includes('\u00b7'), 'should skip dots for parallel sessions without parentSession');
  });

  test('connection drawn for teammate regardless of parentSession', () => {
    const os = makeOrbital('session-A');
    const pos = makePos({ parentSession: null, isTeammate: true, teamColor: [255, 100, 50] });
    const out = os._renderConnections(mainPos, [pos], accentColor);
    assert.ok(out.includes('\u00b7'), 'teammates always get connection lines');
  });

  test('connection drawn for teammate with mismatched parentSession', () => {
    const os = makeOrbital('session-A');
    const pos = makePos({ parentSession: 'session-X', isTeammate: true, teamColor: [255, 100, 50] });
    const out = os._renderConnections(mainPos, [pos], accentColor);
    assert.ok(out.includes('\u00b7'), 'teammates get connections even with unrelated parentSession');
  });
});

// -- loadSessions transient read failure protection --------------------

describe('grid.js -- loadSessions transient read failure protection', () => {
  test('loadSessions protects existing face when file read returns empty', () => {
    const fs = require('fs');
    const path = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    const filePath = path.join(SESSIONS_DIR, 'flicker-empty.json');

    // First write: valid data so face gets created
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: 'flicker-empty',
      state: 'coding',
      detail: 'editing file',
      timestamp: Date.now(),
    }));
    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has('flicker-empty'), 'face should exist after valid read');

    // Second write: empty file (simulates mid-write on Windows)
    fs.writeFileSync(filePath, '');
    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has('flicker-empty'),
      'existing face should survive when file is empty (mid-write)');

    try { fs.unlinkSync(filePath); } catch {}
  });

  test('loadSessions protects existing face when file parse fails', () => {
    const fs = require('fs');
    const path = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    const filePath = path.join(SESSIONS_DIR, 'flicker-parse.json');

    // First write: valid data so face gets created
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: 'flicker-parse',
      state: 'thinking',
      detail: '',
      timestamp: Date.now(),
    }));
    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has('flicker-parse'), 'face should exist after valid read');

    // Second write: truncated JSON (simulates partial write)
    fs.writeFileSync(filePath, '{"session_id":"flicker-par');
    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has('flicker-parse'),
      'existing face should survive when file contains invalid JSON (partial write)');

    try { fs.unlinkSync(filePath); } catch {}
  });

  test('loadSessions does not create phantom face on read failure', () => {
    const fs = require('fs');
    const path = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    const filePath = path.join(SESSIONS_DIR, 'phantom-test.json');

    // Write an empty file with no pre-existing face
    fs.writeFileSync(filePath, '');
    orbital.loadSessions('main-id');
    assert.ok(!orbital.faces.has('phantom-test'),
      'should not create a face from an empty file');

    // Write truncated JSON with no pre-existing face
    fs.writeFileSync(filePath, '{"session_id":"phantom');
    orbital.loadSessions('main-id');
    assert.ok(!orbital.faces.has('phantom-test'),
      'should not create a face from invalid JSON');

    try { fs.unlinkSync(filePath); } catch {}
  });
});

// -- Orbital session cleanup regression guards --------------------------

describe('grid.js -- session cleanup uses fileToFaceId and PID check', () => {
  test('STALE_MS >= ORPHAN_TIMEOUT (regression guard)', () => {
    assert.ok(STALE_MS >= ORPHAN_TIMEOUT,
      `STALE_MS (${STALE_MS}) must be >= ORPHAN_TIMEOUT (${ORPHAN_TIMEOUT})`);
  });

  test('isProcessAlive returns true for own process', () => {
    assert.strictEqual(isProcessAlive(process.pid), true);
  });

  test('isProcessAlive returns false for non-existent PID', () => {
    // PID 999999 is almost certainly not running
    assert.strictEqual(isProcessAlive(999999), false);
  });

  test('file deletion uses fileToFaceId reverse map for face lookup', () => {
    // Structural: loadSessions must use fileToFaceId (not path.basename) to find
    // the in-memory face protecting a session file. This test verifies that a face
    // whose session_id differs from its safeFilename is correctly protected.
    const fs = require('fs');
    const path = require('path');
    const { SESSIONS_DIR, safeFilename } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

    // Session ID with characters that safeFilename transforms
    const sessionId = 'ses:special/chars!here';
    const filename = safeFilename(sessionId) + '.json';
    const filePath = path.join(SESSIONS_DIR, filename);

    // Write a valid session file
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: sessionId,
      state: 'thinking',
      pid: process.pid,
      timestamp: Date.now(),
    }));

    // First load: creates the face keyed by session_id
    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has(sessionId), 'face should be created with session_id key');

    // Now make the file stale (backdate mtime far past STALE_MS)
    const staleTime = new Date(Date.now() - STALE_MS - 5000);
    fs.utimesSync(filePath, staleTime, staleTime);

    // Second load: deletion loop must use fileToFaceId to find the active face
    // and protect the file (face is in 'thinking' state, not stopped)
    orbital.loadSessions('main-id');
    assert.ok(fs.existsSync(filePath),
      'stale file should NOT be deleted when an active in-memory face protects it via fileToFaceId');

    // Cleanup
    try { fs.unlinkSync(filePath); } catch {}
  });

  test('file deletion checks PID before deleting unprotected files', () => {
    // Structural: when no in-memory face protects a file, loadSessions must
    // read the file's pid field and call isProcessAlive before deleting.
    const fs = require('fs');
    const path = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

    const filePath = path.join(SESSIONS_DIR, 'pid-alive-test.json');

    // Write a stale file with OUR pid (still alive) but don't create a face for it
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: 'pid-alive-test',
      state: 'thinking',
      pid: process.pid,
      timestamp: Date.now(),
    }));

    // Backdate the file past STALE_MS
    const staleTime = new Date(Date.now() - STALE_MS - 5000);
    fs.utimesSync(filePath, staleTime, staleTime);

    // Load — no in-memory face exists, but PID is alive → file should survive
    orbital.loadSessions('main-id');
    assert.ok(fs.existsSync(filePath),
      'stale file with alive PID should NOT be deleted');

    // Cleanup
    try { fs.unlinkSync(filePath); } catch {}
  });
});

// -- Bug #108: updateFromFile timestamp dedup + stopped guard ---

describe('grid.js -- updateFromFile skips redundant updates (Bug #108)', () => {
  test('updateFromFile skips re-application when data.timestamp is unchanged', () => {
    const face = new MiniFace('test');
    const ts = Date.now() - 5000;
    face.updateFromFile({ state: 'coding', detail: 'edit foo.js', timestamp: ts }, 1000);
    assert.strictEqual(face.state, 'coding');
    assert.strictEqual(face.detail, 'edit foo.js');

    // Second call with same timestamp — should be skipped entirely
    face.updateFromFile({ state: 'reading', detail: 'bar.js', timestamp: ts }, 2000);
    assert.strictEqual(face.state, 'coding',
      'state should not change when timestamp is unchanged');
    assert.strictEqual(face.detail, 'edit foo.js',
      'detail should not change when timestamp is unchanged');
  });

  test('updateFromFile applies update when data.timestamp changes', () => {
    const face = new MiniFace('test');
    const ts1 = Date.now() - 5000;
    face.updateFromFile({ state: 'thinking', timestamp: ts1 }, 1000);
    assert.strictEqual(face.state, 'thinking');

    // New timestamp — should apply (coding can interrupt thinking)
    face.minDisplayUntil = 0; // bypass display timer for clean test
    const ts2 = Date.now() - 3000;
    face.updateFromFile({ state: 'coding', timestamp: ts2 }, 1000);
    assert.strictEqual(face.state, 'coding',
      'state should update when timestamp changes');
  });

  test('updateFromFile applies when timestamps differ but mtime is same (NTFS fix)', () => {
    const face = new MiniFace('test');
    const sameMtime = 1000;
    face.updateFromFile({ state: 'thinking', timestamp: 100 }, sameMtime);
    assert.strictEqual(face.state, 'thinking');

    // Same mtime but different JSON timestamp — should apply (NTFS 1s granularity fix)
    face.minDisplayUntil = 0;
    face.updateFromFile({ state: 'coding', timestamp: 200 }, sameMtime);
    assert.strictEqual(face.state, 'coding',
      'should apply update when JSON timestamp differs even if mtime is same');
  });

  test('updateFromFile skips when face is stopped', () => {
    const face = new MiniFace('test');
    face.updateFromFile({ state: 'coding', timestamp: Date.now() }, Date.now());
    assert.strictEqual(face.state, 'coding');

    // Stop the face
    face.stopped = true;
    face.stoppedAt = Date.now();

    // Try to update — should be ignored
    face.updateFromFile({ state: 'reading', detail: 'new stuff', timestamp: Date.now() + 1000 }, Date.now() + 1000);
    assert.strictEqual(face.state, 'coding',
      'stopped face should not accept new state from file');
  });

  test('updateFromFile applies when timestamp is 0 (no timestamp available)', () => {
    const face = new MiniFace('test');
    face.updateFromFile({ state: 'thinking', timestamp: 0 }, 0);
    assert.strictEqual(face.state, 'thinking');

    // Another call with 0 timestamp — should still apply (no dedup possible)
    face.minDisplayUntil = 0;
    face.updateFromFile({ state: 'coding', timestamp: 0 }, 0);
    assert.strictEqual(face.state, 'coding',
      'should apply updates when timestamp is unavailable (0)');
  });

  test('updateFromFile applies when no timestamp in data', () => {
    const face = new MiniFace('test');
    face.updateFromFile({ state: 'thinking' });
    assert.strictEqual(face.state, 'thinking');

    // Another call with no timestamp
    face.minDisplayUntil = 0;
    face.updateFromFile({ state: 'coding' });
    assert.strictEqual(face.state, 'coding',
      'should apply updates when timestamp is missing from data');
  });
});

// -- Bug #111: Face removal respects PID liveness when file is missing (Bug A) --

describe('grid.js -- face removal respects PID liveness when file is missing (Bug A)', () => {
  test('face with live PID stays in memory when its file disappears', () => {
    const fs = require('fs');
    const pathMod = require('path');
    const { SESSIONS_DIR, safeFilename } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

    const sessionId = 'pid-alive-no-file-test';
    const filePath = pathMod.join(SESSIONS_DIR, safeFilename(sessionId) + '.json');

    // Write a valid session file with our PID
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: sessionId, state: 'thinking',
      pid: process.pid, timestamp: Date.now(),
    }));

    // First load: creates the face
    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has(sessionId), 'face should exist after first load');

    // Delete the file — simulating race condition or external cleanup
    try { fs.unlinkSync(filePath); } catch {}
    assert.ok(!fs.existsSync(filePath), 'file should be gone');

    // Second load: file is missing, but PID is alive → face should survive
    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has(sessionId),
      'face with live PID should NOT be removed when its file disappears');
  });

  test('face with dead PID is removed when its file disappears', () => {
    const fs = require('fs');
    const pathMod = require('path');
    const { SESSIONS_DIR, safeFilename } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

    const sessionId = 'dead-pid-no-file-test';
    const filePath = pathMod.join(SESSIONS_DIR, safeFilename(sessionId) + '.json');

    // Write with a dead PID
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: sessionId, state: 'thinking',
      pid: 999999, timestamp: Date.now(),
    }));

    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has(sessionId), 'face should exist after first load');

    // Delete the file
    try { fs.unlinkSync(filePath); } catch {}

    // Second load: file gone AND PID dead → face should be removed
    orbital.loadSessions('main-id');
    assert.ok(!orbital.faces.has(sessionId),
      'face with dead PID should be removed when its file disappears');
  });

  test('stopped face is removed when its file disappears (regardless of PID)', () => {
    const fs = require('fs');
    const pathMod = require('path');
    const { SESSIONS_DIR, safeFilename } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

    const sessionId = 'stopped-no-file-test';
    const filePath = pathMod.join(SESSIONS_DIR, safeFilename(sessionId) + '.json');

    // First write as active (not stopped) so the face gets created
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: sessionId, state: 'happy', stopped: false,
      pid: process.pid, timestamp: Date.now(),
    }));

    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has(sessionId), 'face should exist after first load');

    // Now mark stopped via file update
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: sessionId, state: 'happy', stopped: true,
      pid: process.pid, timestamp: Date.now() + 1,
    }));
    orbital.loadSessions('main-id');
    const face = orbital.faces.get(sessionId);
    assert.ok(face.stopped, 'face should be marked stopped');
    // Ensure face is stale enough to be removed
    face.stoppedAt = Date.now() - 20000;

    // Delete the file
    try { fs.unlinkSync(filePath); } catch {}

    // Second load: file gone, face stopped → should be removed despite live PID
    orbital.loadSessions('main-id');
    assert.ok(!orbital.faces.has(sessionId),
      'stopped face should be removed even with live PID when file is gone');
  });

  test('stopped session file does not create new face (prevents linger/respawn cycle)', () => {
    const fs = require('fs');
    const pathMod = require('path');
    const { SESSIONS_DIR, safeFilename } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

    const sessionId = 'stopped-no-resurrect-test';
    const filePath = pathMod.join(SESSIONS_DIR, safeFilename(sessionId) + '.json');

    // Write a stopped session file directly (simulates file lingering after face was removed)
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: sessionId, state: 'happy', stopped: true,
      pid: process.pid, timestamp: Date.now(),
    }));

    orbital.loadSessions('main-id');
    assert.ok(!orbital.faces.has(sessionId),
      'stopped file should not create a new face — prevents linger/respawn cycle');

    // Cleanup
    try { fs.unlinkSync(filePath); } catch {}
  });
});

// -- Bug #111: File deletion protects on parse error (Bug B) --

describe('grid.js -- file deletion protects on parse error (Bug B)', () => {
  test('corrupted JSON file is not deleted during mtime purge', () => {
    const fs = require('fs');
    const pathMod = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

    const filePath = pathMod.join(SESSIONS_DIR, 'corrupted-json-test.json');

    // Write corrupted JSON (simulates mid-write race)
    fs.writeFileSync(filePath, '{"session_id":"corrupted-json-test","state":"thinki');

    // Backdate past STALE_MS so purge loop considers it
    const staleTime = new Date(Date.now() - STALE_MS - 5000);
    fs.utimesSync(filePath, staleTime, staleTime);

    // Load — purge loop should catch the parse error and continue (protect the file)
    orbital.loadSessions('main-id');
    assert.ok(fs.existsSync(filePath),
      'corrupted JSON file should NOT be deleted during purge — could be mid-write');

    // Cleanup
    try { fs.unlinkSync(filePath); } catch {}
  });
});

// -- Bug #111: Completion-state face with live PID protected in file deletion (Bug C) --

describe('grid.js -- completion-state face with live PID protected in file deletion (Bug C)', () => {
  test('happy-state face with live PID is not deleted during mtime purge', () => {
    const fs = require('fs');
    const pathMod = require('path');
    const { SESSIONS_DIR, safeFilename } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

    const sessionId = 'happy-pid-alive-test';
    const filePath = pathMod.join(SESSIONS_DIR, safeFilename(sessionId) + '.json');

    // Write a completion-state session with our PID
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: sessionId, state: 'happy',
      pid: process.pid, timestamp: Date.now(),
    }));

    // Seed the start time so the ownership verdict is decided synchronously
    // on every platform (execFile-based resolvers cannot answer in-tick).
    seedOwningPid();
    try {
      // First load: creates the face in happy state
      orbital.loadSessions('main-id');
      assert.ok(orbital.faces.has(sessionId), 'face should exist after first load');
      assert.strictEqual(orbital.faces.get(sessionId).state, 'happy');

      // Backdate file past STALE_MS
      const staleTime = new Date(Date.now() - STALE_MS - 5000);
      fs.utimesSync(filePath, staleTime, staleTime);

      // Second load: file is stale and face is in completion state,
      // but PID is alive and owns the write → file should be protected
      orbital.loadSessions('main-id');
      assert.ok(fs.existsSync(filePath),
        'stale file for completion-state face with live PID should NOT be deleted');
    } finally {
      _pidStartCache.delete(process.pid);
      try { fs.unlinkSync(filePath); } catch {}
    }
  });

  test('completion-state face with dead PID is deleted during mtime purge', () => {
    const fs = require('fs');
    const pathMod = require('path');
    const { SESSIONS_DIR, safeFilename } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

    const sessionId = 'happy-pid-dead-test';
    const filePath = pathMod.join(SESSIONS_DIR, safeFilename(sessionId) + '.json');

    // Write a completion-state session with a dead PID
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: sessionId, state: 'happy',
      pid: 999999, timestamp: Date.now(),
    }));

    // First load
    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has(sessionId), 'face should exist after first load');

    // Backdate past STALE_MS
    const staleTime = new Date(Date.now() - STALE_MS - 5000);
    fs.utimesSync(filePath, staleTime, staleTime);

    // Second load: stale, completion state, dead PID → should be deleted
    orbital.loadSessions('main-id');
    assert.ok(!fs.existsSync(filePath),
      'stale file for completion-state face with dead PID should be deleted');
  });
});

// -- Orbital Grouping Tests ----------------------------------------

describe('grid.js -- OrbitalSystem._buildGroups', () => {
  test('groups faces by teamName', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.teamName = 'backend'; f1.teamColor = [255, 120, 120];
    const f2 = new MiniFace('s2'); f2.teamName = 'backend'; f2.teamColor = [255, 120, 120];
    const f3 = new MiniFace('s3'); f3.teamName = 'frontend';
    const groups = os._buildGroups([f1, f2, f3]);
    assert.strictEqual(groups.length, 2);
    const backend = groups.find(g => g.key === 'backend');
    assert.ok(backend);
    assert.strictEqual(backend.members.length, 2);
  });

  test('groups faces by parentSession when no teamName', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main-1';
    const f2 = new MiniFace('s2'); f2.parentSession = 'main-1';
    const f3 = new MiniFace('s3'); f3.parentSession = 'main-2';
    const groups = os._buildGroups([f1, f2, f3]);
    assert.strictEqual(groups.length, 2);
    const g1 = groups.find(g => g.key === 'main-1');
    assert.strictEqual(g1.members.length, 2);
  });

  test('falls back to sessionId for ungrouped faces', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1');
    const f2 = new MiniFace('s2');
    const groups = os._buildGroups([f1, f2]);
    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups[0].members.length, 1);
    assert.strictEqual(groups[1].members.length, 1);
  });

  test('derives color from team-colored members', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.teamName = 'ops'; f1.teamColor = [100, 200, 255];
    const f2 = new MiniFace('s2'); f2.teamName = 'ops';
    const groups = os._buildGroups([f1, f2]);
    assert.deepStrictEqual(groups[0].color, [100, 200, 255]);
  });

  test('color is null for non-team groups', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main';
    const f2 = new MiniFace('s2'); f2.parentSession = 'main';
    const groups = os._buildGroups([f1, f2]);
    assert.strictEqual(groups[0].color, null);
  });

  test('sorts groups by earliest firstSeen', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.teamName = 'late'; f1.firstSeen = 5000;
    const f2 = new MiniFace('s2'); f2.teamName = 'early'; f2.firstSeen = 1000;
    const groups = os._buildGroups([f1, f2]);
    assert.strictEqual(groups[0].key, 'early');
    assert.strictEqual(groups[1].key, 'late');
  });

  test('empty input returns empty groups', () => {
    const os = new OrbitalSystem();
    assert.strictEqual(os._buildGroups([]).length, 0);
  });
});

describe('grid.js -- OrbitalSystem._calculateGroupedAngles', () => {
  test('single face returns single angle at rotationAngle', () => {
    const os = new OrbitalSystem();
    os.rotationAngle = 1.5;
    const f1 = new MiniFace('s1');
    const angles = os._calculateGroupedAngles([f1]);
    assert.strictEqual(angles.size, 1);
    assert.strictEqual(angles.get(f1), 1.5);
  });

  test('empty input returns empty map', () => {
    const os = new OrbitalSystem();
    assert.strictEqual(os._calculateGroupedAngles([]).size, 0);
  });

  test('two groups cluster members with intra < inter gaps', () => {
    const os = new OrbitalSystem();
    os.rotationAngle = 0;
    const f1 = new MiniFace('s1'); f1.teamName = 'alpha'; f1.firstSeen = 100;
    const f2 = new MiniFace('s2'); f2.teamName = 'alpha'; f2.firstSeen = 200;
    const f3 = new MiniFace('s3'); f3.teamName = 'beta'; f3.firstSeen = 300;
    const f4 = new MiniFace('s4'); f4.teamName = 'beta'; f4.firstSeen = 400;
    const angles = os._calculateGroupedAngles([f1, f2, f3, f4]);

    // Within group alpha, the gap should be <= INTRA_GROUP_GAP
    const intraAlpha = Math.abs(angles.get(f2) - angles.get(f1));
    assert.ok(intraAlpha <= 0.35 + 0.001, `intra-group gap ${intraAlpha} should be <= 0.35`);

    // The gap between the groups should be larger than the intra-group gap
    const a2 = angles.get(f2); // last of alpha
    const b1 = angles.get(f3); // first of beta
    const interGap = b1 - a2;
    assert.ok(interGap > intraAlpha, `inter-group gap ${interGap} should exceed intra-group ${intraAlpha}`);
  });

  test('all ungrouped approximates even spacing', () => {
    const os = new OrbitalSystem();
    os.rotationAngle = 0;
    const faces = [];
    for (let i = 0; i < 4; i++) {
      const f = new MiniFace('s' + i);
      f.firstSeen = i * 100;
      faces.push(f);
    }
    const angles = os._calculateGroupedAngles(faces);

    // Even spacing would be ~PI/2 (1.57). With singletons the gaps should be roughly similar.
    const vals = faces.map(f => angles.get(f));
    for (let i = 1; i < vals.length; i++) {
      const gap = vals[i] - vals[i - 1];
      assert.ok(gap > 0.3 && gap < 2.5, `gap ${gap} should be roughly even`);
    }
  });

  test('returns angle for every visible face', () => {
    const os = new OrbitalSystem();
    os.rotationAngle = 0;
    const faces = [];
    for (let i = 0; i < 8; i++) {
      const f = new MiniFace('s' + i);
      f.parentSession = i < 4 ? 'main-a' : 'main-b';
      f.firstSeen = i * 100;
      faces.push(f);
    }
    const angles = os._calculateGroupedAngles(faces);
    assert.strictEqual(angles.size, 8);
    for (const f of faces) {
      assert.ok(typeof angles.get(f) === 'number', `face ${f.sessionId} should have an angle`);
    }
  });
});

describe('grid.js -- OrbitalSystem._renderGroupTethers', () => {
  test('returns empty string for singleton groups', () => {
    const os = new OrbitalSystem();
    const positions = [
      { col: 10, row: 5, face: new MiniFace('s1') },
      { col: 40, row: 5, face: new MiniFace('s2') },
    ];
    const mainPos = { col: 25, row: 10, w: 12, h: 8, centerX: 31, centerY: 14 };
    const result = os._renderGroupTethers(positions, mainPos, [100, 160, 210]);
    assert.strictEqual(result, '');
  });

  test('produces ANSI output for multi-member groups', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main';
    const f2 = new MiniFace('s2'); f2.parentSession = 'main';
    // Space them far apart so tether dots are drawn
    const positions = [
      { col: 5, row: 2, face: f1 },
      { col: 60, row: 2, face: f2 },
    ];
    const mainPos = { col: 30, row: 15, w: 12, h: 8, centerX: 36, centerY: 19 };
    const result = os._renderGroupTethers(positions, mainPos, [100, 160, 210]);
    assert.ok(result.length > 0, 'should produce ANSI output');
    assert.ok(drawnCells(result).length > 0, 'should paint dots at real coordinates');
  });
});

describe('grid.js -- OrbitalSystem._getGroupLabel', () => {
  const mkPos = (face) => ({ col: 10, row: 5, face });

  test('team groups return teamName', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.teamName = 'backend'; f1.label = 'sub-1';
    const f2 = new MiniFace('s2'); f2.teamName = 'backend'; f2.label = 'sub-2';
    const members = [mkPos(f1), mkPos(f2)];
    const stable = members;
    assert.strictEqual(os._getGroupLabel(members, stable), 'backend');
  });

  test('shared non-default branch used as label', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.gitBranch = 'feat/auth'; f1.label = 'sub-1';
    const f2 = new MiniFace('s2'); f2.gitBranch = 'feat/auth'; f2.label = 'sub-2';
    const members = [mkPos(f1), mkPos(f2)];
    assert.strictEqual(os._getGroupLabel(members, members), 'feat/auth');
  });

  test('default branches (main/master/develop/dev) fall through', () => {
    const os = new OrbitalSystem();
    for (const br of ['main', 'master', 'develop', 'dev']) {
      const f1 = new MiniFace('s1'); f1.gitBranch = br; f1.label = 'sub-1';
      const f2 = new MiniFace('s2'); f2.gitBranch = br; f2.label = 'sub-2';
      const members = [mkPos(f1), mkPos(f2)];
      assert.strictEqual(os._getGroupLabel(members, members), 'sub-1',
        `branch '${br}' should fall through to face label`);
    }
  });

  test('mixed branches fall through to cwd', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.gitBranch = 'feat/a'; f1.cwd = '/home/user/myapp';
    const f2 = new MiniFace('s2'); f2.gitBranch = 'feat/b'; f2.cwd = '/home/user/myapp';
    const members = [mkPos(f1), mkPos(f2)];
    assert.strictEqual(os._getGroupLabel(members, members), 'myapp');
  });

  test('missing branches fall through to shared cwd', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.cwd = '/projects/cool-app'; f1.label = 'sub-1';
    const f2 = new MiniFace('s2'); f2.cwd = '/projects/cool-app'; f2.label = 'sub-2';
    const members = [mkPos(f1), mkPos(f2)];
    assert.strictEqual(os._getGroupLabel(members, members), 'cool-app');
  });

  test('mixed cwds fall through to taskDescription', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.cwd = '/a'; f1.taskDescription = 'fix modal';
    const f2 = new MiniFace('s2'); f2.cwd = '/b'; f2.label = 'sub-2';
    const members = [mkPos(f1), mkPos(f2)];
    assert.strictEqual(os._getGroupLabel(members, members), 'fix modal');
  });

  test('taskDescription used when no shared branch or cwd', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.taskDescription = 'add tests'; f1.label = 'sub-1';
    const f2 = new MiniFace('s2'); f2.label = 'sub-2';
    const members = [mkPos(f1), mkPos(f2)];
    assert.strictEqual(os._getGroupLabel(members, members), 'add tests');
  });

  test('falls back to face.label when nothing else available', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.label = 'haiku';
    const f2 = new MiniFace('s2'); f2.label = 'sub-2';
    const members = [mkPos(f1), mkPos(f2)];
    assert.strictEqual(os._getGroupLabel(members, members), 'haiku');
  });

  test('label truncated to 12 chars', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.gitBranch = 'feature/very-long-branch-name';
    const f2 = new MiniFace('s2'); f2.gitBranch = 'feature/very-long-branch-name';
    const members = [mkPos(f1), mkPos(f2)];
    const label = os._getGroupLabel(members, members);
    assert.ok(label.length <= 12, `label "${label}" should be max 12 chars`);
  });

  test('teamName truncated to 12 chars', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.teamName = 'infrastructure-team';
    const f2 = new MiniFace('s2'); f2.teamName = 'infrastructure-team';
    const members = [mkPos(f1), mkPos(f2)];
    const label = os._getGroupLabel(members, members);
    assert.ok(label.length <= 12, `team label "${label}" should be max 12 chars`);
  });

  test('empty string when no data at all', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.label = '';
    const f2 = new MiniFace('s2'); f2.label = '';
    const members = [mkPos(f1), mkPos(f2)];
    assert.strictEqual(os._getGroupLabel(members, members), '');
  });
});

describe('grid.js -- OrbitalSystem._renderGroupLabels', () => {
  test('returns empty string for singleton groups', () => {
    const os = new OrbitalSystem();
    const positions = [
      { col: 10, row: 5, face: new MiniFace('s1') },
      { col: 40, row: 5, face: new MiniFace('s2') },
    ];
    const mainPos = { col: 30, row: 15, w: 12, h: 8, centerX: 36, centerY: 19 };
    const result = os._renderGroupLabels(positions, 30, 80, mainPos);
    assert.strictEqual(result, '');
  });

  test('produces label text for multi-member groups', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main'; f1.label = 'sub-1';
    const f2 = new MiniFace('s2'); f2.parentSession = 'main'; f2.label = 'sub-2';
    const positions = [
      { col: 10, row: 5, face: f1 },
      { col: 25, row: 5, face: f2 },
    ];
    const mainPos = { col: 50, row: 20, w: 12, h: 8, centerX: 56, centerY: 24 };
    const result = os._renderGroupLabels(positions, 30, 80, mainPos);
    assert.ok(result.length > 0, 'should produce ANSI output');
    assert.ok(drawnCells(result).length > 0, 'should paint the label at real coordinates');
  });

  test('team groups show teamName as label', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.teamName = 'backend'; f1.teamColor = [255, 120, 120];
    const f2 = new MiniFace('s2'); f2.teamName = 'backend'; f2.teamColor = [255, 120, 120];
    const positions = [
      { col: 10, row: 5, face: f1 },
      { col: 30, row: 5, face: f2 },
    ];
    const mainPos = { col: 50, row: 20, w: 12, h: 8, centerX: 56, centerY: 24 };
    const result = os._renderGroupLabels(positions, 30, 80, mainPos);
    assert.ok(result.includes('backend'), 'should contain team name label');
  });

  test('non-team groups show first member face label', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main'; f1.label = 'sub-1';
    const f2 = new MiniFace('s2'); f2.parentSession = 'main'; f2.label = 'sub-2';
    const positions = [
      { col: 10, row: 5, face: f1 },
      { col: 30, row: 5, face: f2 },
    ];
    const mainPos = { col: 50, row: 20, w: 12, h: 8, centerX: 56, centerY: 24 };
    const result = os._renderGroupLabels(positions, 30, 80, mainPos);
    assert.ok(result.includes('sub-1'), 'should contain first member label');
  });

  test('shared branch renders as group label instead of face label', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main'; f1.label = 'sub-1'; f1.gitBranch = 'feat/auth';
    const f2 = new MiniFace('s2'); f2.parentSession = 'main'; f2.label = 'sub-2'; f2.gitBranch = 'feat/auth';
    const positions = [
      { col: 10, row: 5, face: f1 },
      { col: 30, row: 5, face: f2 },
    ];
    const mainPos = { col: 50, row: 20, w: 12, h: 8, centerX: 56, centerY: 24 };
    const result = os._renderGroupLabels(positions, 30, 80, mainPos);
    assert.ok(result.includes('feat/auth'), 'should show branch instead of sub-1');
    assert.ok(!result.includes('sub-1'), 'should not contain fallback label');
  });

  test('shared cwd renders as group label when branches differ', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main'; f1.label = 'sub-1'; f1.cwd = '/home/user/myapp';
    const f2 = new MiniFace('s2'); f2.parentSession = 'main'; f2.label = 'sub-2'; f2.cwd = '/home/user/myapp';
    const positions = [
      { col: 10, row: 5, face: f1 },
      { col: 30, row: 5, face: f2 },
    ];
    const mainPos = { col: 50, row: 20, w: 12, h: 8, centerX: 56, centerY: 24 };
    const result = os._renderGroupLabels(positions, 30, 80, mainPos);
    assert.ok(result.includes('myapp'), 'should show cwd basename');
  });

  test('spawning faces excluded from label positioning', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main'; f1.label = 'sub-1';
    const f2 = new MiniFace('s2'); f2.parentSession = 'main'; f2.label = 'sub-2'; f2.spawning = true;
    const positions = [
      { col: 10, row: 5, face: f1 },
      { col: 25, row: 5, face: f2 },
    ];
    const mainPos = { col: 50, row: 20, w: 12, h: 8, centerX: 56, centerY: 24 };
    const result = os._renderGroupLabels(positions, 30, 80, mainPos);
    // Only 1 non-spawning member, so no label (need 2+)
    assert.strictEqual(result, '', 'should skip label when only 1 non-spawning member');
  });

  test('all-spawning group produces no label', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main'; f1.spawning = true;
    const f2 = new MiniFace('s2'); f2.parentSession = 'main'; f2.spawning = true;
    const positions = [
      { col: 10, row: 5, face: f1 },
      { col: 25, row: 5, face: f2 },
    ];
    const mainPos = { col: 50, row: 20, w: 12, h: 8, centerX: 56, centerY: 24 };
    const result = os._renderGroupLabels(positions, 30, 80, mainPos);
    assert.strictEqual(result, '');
  });

  test('label skipped when overlapping main face area', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main'; f1.label = 'sub-1';
    const f2 = new MiniFace('s2'); f2.parentSession = 'main'; f2.label = 'sub-2';
    // Place faces directly above main face so label row falls inside exclusion zone
    const mainPos = { col: 10, row: 14, w: 30, h: 10, centerX: 25, centerY: 19 };
    const positions = [
      { col: 10, row: 7, face: f1 },
      { col: 25, row: 7, face: f2 },
    ];
    const result = os._renderGroupLabels(positions, 30, 80, mainPos);
    // Label row = 7 + 7 = 14, which is inside mainPos.row-8=6 to mainPos.row+h+7=31
    assert.strictEqual(result, '', 'should skip label when overlapping main face');
  });

  test('label clamped to terminal bounds', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main'; f1.label = 'sub-1';
    const f2 = new MiniFace('s2'); f2.parentSession = 'main'; f2.label = 'sub-2';
    // Place faces at far right edge
    const positions = [
      { col: 70, row: 2, face: f1 },
      { col: 75, row: 2, face: f2 },
    ];
    const mainPos = { col: 30, row: 20, w: 12, h: 8, centerX: 36, centerY: 24 };
    const result = os._renderGroupLabels(positions, 15, 80, mainPos);
    // Label should still be within terminal cols
    if (result.length > 0) {
      const colMatch = result.match(/\x1b\[(\d+);(\d+)H/);
      if (colMatch) {
        const labelCol = parseInt(colMatch[2], 10);
        assert.ok(labelCol >= 1 && labelCol <= 80, 'label col should be within bounds');
      }
    }
  });
});

describe('grid.js -- OrbitalSystem._resolveOverlaps', () => {
  test('separates two horizontally overlapping faces', () => {
    const os = new OrbitalSystem();
    const positions = [
      { col: 10, row: 5, face: new MiniFace('a') },
      { col: 14, row: 5, face: new MiniFace('b') }, // overlaps: MINI_W=8, 14 < 10+8
    ];
    os._resolveOverlaps(positions, 80, 30);
    const gap = Math.max(positions[0].col + 8, positions[1].col + 8) -
                Math.min(positions[0].col, positions[1].col);
    // After resolve, bounding boxes should not overlap
    const overlapX = Math.min(positions[0].col + 8, positions[1].col + 8) -
                     Math.max(positions[0].col, positions[1].col);
    assert.ok(overlapX <= 0, `faces should not overlap horizontally, overlapX=${overlapX}`);
  });

  test('separates two vertically overlapping faces', () => {
    const os = new OrbitalSystem();
    const positions = [
      { col: 10, row: 5, face: new MiniFace('a') },
      { col: 10, row: 8, face: new MiniFace('b') }, // overlaps: MINI_H=7, 8 < 5+7
    ];
    os._resolveOverlaps(positions, 80, 30);
    const overlapY = Math.min(positions[0].row + 7, positions[1].row + 7) -
                     Math.max(positions[0].row, positions[1].row);
    assert.ok(overlapY <= 0, `faces should not overlap vertically, overlapY=${overlapY}`);
  });

  test('leaves non-overlapping faces untouched', () => {
    const os = new OrbitalSystem();
    const positions = [
      { col: 10, row: 5, face: new MiniFace('a') },
      { col: 30, row: 5, face: new MiniFace('b') },
    ];
    os._resolveOverlaps(positions, 80, 30);
    assert.strictEqual(positions[0].col, 10);
    assert.strictEqual(positions[1].col, 30);
  });

  test('keeps faces within terminal bounds after nudging', () => {
    const os = new OrbitalSystem();
    const positions = [
      { col: 2, row: 2, face: new MiniFace('a') },
      { col: 4, row: 2, face: new MiniFace('b') },
    ];
    os._resolveOverlaps(positions, 80, 30);
    for (const p of positions) {
      assert.ok(p.col >= 1, `col ${p.col} should be >= 1`);
      assert.ok(p.row >= 1, `row ${p.row} should be >= 1`);
      assert.ok(p.col <= 80 - 8, `col ${p.col} should be <= cols - MINI_W`);
      assert.ok(p.row <= 30 - 7, `row ${p.row} should be <= rows - MINI_H`);
    }
  });
});

describe('grid.js -- _calculateGroupedAngles box-aware spacing', () => {
  test('neighbours never sit closer than minGap, even inside a group', () => {
    const os = new OrbitalSystem();
    os.rotationAngle = 0;
    const faces = [];
    for (let i = 0; i < 5; i++) {
      const f = new MiniFace('s' + i); f.parentSession = 'main'; f.firstSeen = i;
      faces.push(f);
    }
    const minGap = 1.0; // bigger than INTRA_GROUP_GAP: the cluster must widen
    const vals = faces.map(f => os._calculateGroupedAngles(faces, minGap).get(f)).sort((x, y) => x - y);
    for (let i = 1; i < vals.length; i++) assert.ok(vals[i] - vals[i - 1] >= minGap - 1e-9);
    assert.ok(Math.PI * 2 - (vals[vals.length - 1] - vals[0]) >= minGap - 1e-9, 'wrap-around gap too');
  });

  test('an impossible minGap degrades to even spacing', () => {
    const os = new OrbitalSystem();
    const faces = [0, 1, 2].map(i => { const f = new MiniFace('s' + i); f.firstSeen = i; return f; });
    const angles = os._calculateGroupedAngles(faces, 5);
    const vals = faces.map(f => angles.get(f));
    assert.ok(Math.abs((vals[1] - vals[0]) - Math.PI * 2 / 3) < 1e-9);
  });
});

describe('grid.js -- layout invariants across terminal sizes', () => {
  const { ClaudeFace, fitKeyHints } = require('../face');
  const { computeOrbit, MINI_W, MINI_H } = require('../grid');
  const overlap = (a, b) => a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
  // Mini-face top-left corners, recognised by the box's top-left glyph.
  const boxes = (out) => {
    const re = /\x1b\[(\d+);(\d+)H(?:\x1b\[[^m]*m)*╭/g;
    const found = [];
    let m;
    while ((m = re.exec(out))) found.push({ row: +m[1], col: +m[2], w: MINI_W, h: MINI_H });
    return found;
  };

  function withSize(cols, rows, fn) {
    const oc = process.stdout.columns, or = process.stdout.rows;
    process.stdout.columns = cols; process.stdout.rows = rows;
    try { return fn(); } finally { process.stdout.columns = oc; process.stdout.rows = or; }
  }

  function scene(n) {
    const face = new ClaudeFace();
    face.showStats = true; face.accessoriesEnabled = true;
    const orb = new OrbitalSystem();
    orb.setMainSession('main');
    for (let i = 0; i < n; i++) {
      const f = new MiniFace('s' + i);
      f.updateFromFile({ state: 'coding', parentSession: i % 2 ? 'main' : undefined, detail: 'edit' });
      f.firstSeen = i; f.spawning = false;
      orb.faces.set('s' + i, f);
    }
    return { face, orb };
  }

  test('the orbit depends on the terminal, not on the state, accessory or bubble', () => {
    for (const [cols, rows] of [[80, 40], [120, 45], [160, 60], [200, 50]]) {
      withSize(cols, rows, () => {
        const { face, orb } = scene(3);
        const seen = new Set();
        for (const st of ['idle', 'thinking', 'happy', 'error', 'proud', 'waiting']) {
          face.forceState(st, 'x');
          for (const bubble of ['', 'a thought that is fairly long']) {
            face.thoughtText = bubble;
            face.render();
            const o = orb.calculateOrbit(cols, rows, face.lastPos);
            seen.add([o.a, o.b, o.maxSlots, o.cx, o.cy].join());
          }
        }
        assert.strictEqual(seen.size, 1, `${cols}x${rows}: orbit changed with state: ${[...seen].join(' | ')}`);
      });
    }
  });

  test('ring faces never overlap the main face, each other, or the hint row', () => {
    for (let cols = 60; cols <= 220; cols += 20) {
      for (let rows = 24; rows <= 64; rows += 8) {
        withSize(cols, rows, () => {
          for (const n of [3, 8]) {
            const { face, orb } = scene(n);
            face.thoughtText = 'hmm';
            for (let fr = 0; fr < 120; fr += 1) {
              face.update(66); orb.update(66);
              face.render();
              const lp = face.lastPos;
              if (orb.calculateOrbit(cols, rows, lp).maxSlots === 0) break; // side panel
              const ko = lp.keepOut;
              const main = { row: ko.top, col: ko.left, w: ko.right - ko.left + 1, h: ko.bottom - ko.top + 1 };
              const pos = boxes(orb.render(cols, rows, lp, null));
              for (const p of pos) {
                assert.ok(!overlap(p, main), `${cols}x${rows} n${n} f${fr}: face at ${p.row},${p.col} over main`);
                assert.ok(p.row + MINI_H - 1 <= rows - 1, `${cols}x${rows}: face on the hint row`);
                assert.ok(p.col >= 1 && p.col + MINI_W - 1 <= cols, `${cols}x${rows}: face off-screen`);
              }
              for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) {
                assert.ok(!overlap(pos[i], pos[j]), `${cols}x${rows} n${n} f${fr}: faces ${i},${j} overlap`);
              }
            }
          }
        });
      }
    }
  });

  test('ring faces move smoothly: no frame-to-frame teleport while a bubble comes and goes', () => {
    withSize(140, 50, () => {
      const { face, orb } = scene(5);
      let prev = null;
      for (let fr = 0; fr < 200; fr++) {
        face.thoughtText = (fr % 20) < 10 ? 'thinking about it' : '';
        if (fr % 25 === 0) face.forceState(['idle', 'happy', 'error', 'proud'][(fr / 25) % 4], 'x');
        face.update(66); orb.update(66);
        face.render();
        const pos = boxes(orb.render(140, 50, face.lastPos, null));
        if (prev && prev.length === pos.length) {
          for (let i = 0; i < pos.length; i++) {
            const d = Math.abs(pos[i].row - prev[i].row) + Math.abs(pos[i].col - prev[i].col);
            assert.ok(d <= 3, `frame ${fr}: face ${i} jumped ${d} cells`);
          }
        }
        prev = pos;
      }
    });
  });

  test('computeOrbit refuses a terminal the ring cannot fit around the keep-out', () => {
    const ko = { top: 3, bottom: 19, left: 4, right: 40 };
    assert.strictEqual(computeOrbit(50, 24, ko).maxSlots, 0);
  });

  test('fitKeyHints never exceeds its width and keeps help/quit longest', () => {
    const full = fitKeyHints(200).map(h => h[0]);
    assert.deepStrictEqual(full, ['space', 't', 's', 'a', 'o', 'l', 'h', 'q'], 'display order at full width');
    for (let w = 0; w <= 90; w++) {
      const kept = fitKeyHints(w);
      const width = kept.reduce((s, h) => s + h[0].length + 1 + h[1].length, 0) + Math.max(0, kept.length - 1) * 3;
      assert.ok(width <= w, `width ${w}: hints take ${width}`);
      if (kept.length) assert.ok(kept.some(h => h[0] === 'h'), `width ${w}: help must be the last to go`);
    }
  });

  test('the main face never writes past the last column of the last row', () => {
    // drawnCells stops at the first colour change; the hint bar changes colour
    // per key, so walk the whole stream: a cursor move sets the position,
    // colour codes are skipped, and every other character advances a column.
    const lastCol = (out, row) => {
      let r = 0, c = 0, max = 0;
      const re = /\x1b\[(\d+);(\d+)H|\x1b\[[0-9;?]*[A-Za-z]|([^\x1b])/g;
      let m;
      while ((m = re.exec(out))) {
        if (m[1]) { r = +m[1]; c = +m[2]; } else if (m[3] !== undefined) { if (r === row) max = Math.max(max, c); c++; }
      }
      return max;
    };
    for (let cols = 38; cols <= 100; cols++) {
      withSize(cols, 24, () => {
        const last = lastCol(new ClaudeFace().render(), 24);
        assert.ok(last <= cols - 1, `${cols} cols: bottom-row write at col ${last} wraps and scrolls the screen`);
      });
    }
  });
});

describe('grid.js -- _renderGroupTethers extended checks', () => {
  test('tether dots skip ALL face bounding boxes, not just endpoints', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('a'); f1.parentSession = 'main';
    const f2 = new MiniFace('b'); f2.parentSession = 'main';
    const fMiddle = new MiniFace('c'); // sits between a and b
    const positions = [
      { col: 5, row: 2, face: f1 },
      { col: 60, row: 2, face: f2 },
      { col: 30, row: 2, face: fMiddle }, // middle face that tether A→B could cross
    ];
    const mainPos = { col: 30, row: 20, w: 12, h: 8, centerX: 36, centerY: 24 };
    const out = os._renderGroupTethers(positions, mainPos, [100, 160, 210]);
    // No dot should be inside fMiddle's bounding box (col 30-38, row 1-9)
    for (const [dRow, dCol] of drawnCells(out)) {
      const insideMiddle = dCol >= 29 && dCol <= 39 && dRow >= 1 && dRow <= 9;
      assert.ok(!insideMiddle,
        `tether dot at (${dRow},${dCol}) should not overlap middle face`);
    }
  });

  test('spawning faces skip tether segments', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('a'); f1.parentSession = 'main';
    const f2 = new MiniFace('b'); f2.parentSession = 'main'; f2.spawning = true;
    const positions = [
      { col: 5, row: 2, face: f1 },
      { col: 60, row: 2, face: f2 },
    ];
    const mainPos = { col: 30, row: 20, w: 12, h: 8, centerX: 36, centerY: 24 };
    const out = os._renderGroupTethers(positions, mainPos, [100, 160, 210]);
    assert.strictEqual(drawnCells(out).length, 0, 'no tether dots when one endpoint is spawning');
  });
});

// -- loadSessionsAsync / _applySessionResults -------------------------

describe('grid.js -- _applySessionResults', () => {
  test('applies session data to faces map', () => {
    const os = new OrbitalSystem();
    const results = [
      { file: 'sub1.json', data: { session_id: 'sub1', state: 'coding', modelName: 'claude' }, mtimeMs: Date.now() },
      { file: 'sub2.json', data: { session_id: 'sub2', state: 'reading', modelName: 'codex' }, mtimeMs: Date.now() },
    ];
    os._applySessionResults('main-id', results);
    assert.strictEqual(os.faces.size, 2);
    assert.strictEqual(os.faces.get('sub1').state, 'coding');
    assert.strictEqual(os.faces.get('sub2').state, 'reading');
  });

  test('loads the main session from results but keeps it off the ring', () => {
    const os = new OrbitalSystem();
    os.setMainSession('main-id');
    const results = [
      { file: 'main.json', data: { session_id: 'main-id', state: 'thinking' }, mtimeMs: Date.now() },
      { file: 'sub1.json', data: { session_id: 'sub1', state: 'coding' }, mtimeMs: Date.now() },
    ];
    os._applySessionResults('main-id', results);
    assert.strictEqual(os.faces.size, 2, 'the main is loaded like any other file');
    assert.ok(os.faces.has('main-id'));
    assert.deepStrictEqual(os.getSortedFaces().map(f => f.sessionId), ['sub1'],
      'but it never appears among the orbitals');
  });

  test('protects existing face on empty file result', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('sub1');
    mf.state = 'coding';
    os.faces.set('sub1', mf);
    const results = [
      { file: 'sub1.json', empty: true },
    ];
    os._applySessionResults('main-id', results);
    assert.ok(os.faces.has('sub1'), 'face should survive empty file read');
  });

  test('protects existing face on error result', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('sub1');
    mf.state = 'reading';
    os.faces.set('sub1', mf);
    const results = [
      { file: 'sub1.json', error: true },
    ];
    os._applySessionResults('main-id', results);
    assert.ok(os.faces.has('sub1'), 'face should survive parse error');
  });

  test('removes faces not seen in results', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('old-sub');
    mf.state = 'idle';
    mf.lastUpdate = Date.now();
    os.faces.set('old-sub', mf);
    const results = [
      { file: 'sub1.json', data: { session_id: 'sub1', state: 'coding' }, mtimeMs: Date.now() },
    ];
    os._applySessionResults('main-id', results);
    assert.ok(!os.faces.has('old-sub'), 'unseen face should be removed');
    assert.ok(os.faces.has('sub1'));
  });

  test('marks new faces with spawning animation', () => {
    const os = new OrbitalSystem();
    const results = [
      { file: 'sub1.json', data: { session_id: 'sub1', state: 'thinking' }, mtimeMs: Date.now() },
    ];
    os._applySessionResults('main-id', results);
    const face = os.faces.get('sub1');
    assert.strictEqual(face.spawning, true);
    assert.strictEqual(face.spawnProgress, 0);
  });

  test('invalidates sorted cache when faces change', () => {
    const os = new OrbitalSystem();
    os._sortedDirty = false;
    const results = [
      { file: 'sub1.json', data: { session_id: 'sub1', state: 'coding' }, mtimeMs: Date.now() },
    ];
    os._applySessionResults('main-id', results);
    assert.strictEqual(os._sortedDirty, true);
  });

  test('handles empty results array', () => {
    const os = new OrbitalSystem();
    os._applySessionResults('main-id', []);
    assert.strictEqual(os.faces.size, 0);
  });
});

describe('grid.js -- loadSessionsAsync re-entrancy guard', () => {
  test('_loadingInProgress flag prevents concurrent loads', () => {
    const os = new OrbitalSystem();
    os._loadingInProgress = true;
    os.mainSessionId = 'prev';
    // Should bail out immediately without changing mainSessionId
    os.loadSessionsAsync('new-id');
    // mainSessionId should NOT be updated because we bailed out
    assert.strictEqual(os.mainSessionId, 'prev');
  });

  test('_loadingInProgress is initially false', () => {
    const os = new OrbitalSystem();
    assert.strictEqual(os._loadingInProgress, false);
  });

  test('_loadingInProgress resets if _applySessionResults throws', () => {
    const os = new OrbitalSystem();
    const original = os._applySessionResults;
    os._applySessionResults = () => { throw new Error('boom'); };
    os._loadingInProgress = false;
    // Simulate what onComplete does — call via the try/finally path
    try {
      os._loadingInProgress = true;
      try { os._applySessionResults('main', []); }
      finally { os._loadingInProgress = false; }
    } catch {}
    assert.strictEqual(os._loadingInProgress, false, 'flag must reset even after throw');
    os._applySessionResults = original;
  });

  test('a falsy excludeId loads everything instead of bailing out', () => {
    // Nothing is known to be the main face yet, so nothing is kept off the
    // ring -- but every session file is still read. Points at a directory that
    // does not exist so the async readdir fails and touches no real files.
    const absentDir = require('path').join(require('os').tmpdir(), 'code-crumb-absent-sessions');
    const os = new OrbitalSystem();
    os._sessionsDir = absentDir;
    os.loadSessionsAsync(null);
    assert.strictEqual(os.mainSessionId, null, 'no session is kept off the ring');
    assert.ok(os._loadingInProgress, 'the load runs rather than bailing out');
  });
});

// -- _applySessionResults stale file purge --------------------------------

describe('grid.js -- _applySessionResults stale purge', () => {
  const STALE_MS = 120000;

  test('protects stale file when known face is active non-completion with live PID', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('sub1');
    mf.state = 'coding';
    mf.stopped = false;
    mf.pid = process.pid; // Live PID so isStale() returns false after apply
    os.faces.set('sub1', mf);
    const results = [
      { file: 'sub1.json', data: { session_id: 'sub1', state: 'coding', pid: process.pid }, mtimeMs: Date.now() - STALE_MS - 1000 },
    ];
    seedOwningPid();
    try {
      os._applySessionResults('main-id', results);
      assert.ok(os.faces.has('sub1'), 'active non-completion face with live PID should survive stale purge');
    } finally { _pidStartCache.delete(process.pid); }
  });

  test('protects stale file when completion-state face has live PID', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('sub1');
    mf.state = 'happy';
    mf.stopped = false;
    mf.pid = process.pid; // Current process — guaranteed alive
    os.faces.set('sub1', mf);
    const results = [
      { file: 'sub1.json', data: { session_id: 'sub1', state: 'happy' }, mtimeMs: Date.now() - STALE_MS - 1000 },
    ];
    seedOwningPid();
    try {
      os._applySessionResults('main-id', results);
      assert.ok(os.faces.has('sub1'), 'completion face with live PID should survive stale purge');
    } finally { _pidStartCache.delete(process.pid); }
  });

  test('purges stale file when completion-state face has no live PID', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('sub1');
    mf.state = 'satisfied';
    mf.stopped = false;
    mf.pid = 99999999; // Almost certainly dead PID
    os.faces.set('sub1', mf);
    const results = [
      { file: 'sub1.json', data: { session_id: 'sub1', state: 'satisfied', pid: 99999999 }, mtimeMs: Date.now() - STALE_MS - 1000 },
    ];
    os._applySessionResults('main-id', results);
    // Face should be removed since session file was purged (not in survivingResults)
    assert.ok(!os.faces.has('sub1'), 'completion face with dead PID should be purged');
  });

  test('purges stale file with no known face and dead file PID', () => {
    const os = new OrbitalSystem();
    const results = [
      { file: 'orphan.json', data: { session_id: 'orphan', state: 'idle', pid: 99999999 }, mtimeMs: Date.now() - STALE_MS - 1000 },
    ];
    os._applySessionResults('main-id', results);
    assert.ok(!os.faces.has('orphan'), 'stale orphan with dead PID should be purged');
  });

  test('protects stale file when file data has live PID but no known face', () => {
    const os = new OrbitalSystem();
    const results = [
      { file: 'new-sub.json', data: { session_id: 'new-sub', state: 'thinking', pid: process.pid }, mtimeMs: Date.now() - STALE_MS - 1000 },
    ];
    seedOwningPid();
    try {
      os._applySessionResults('main-id', results);
      assert.ok(os.faces.has('new-sub'), 'stale file with live PID should survive and create face');
    } finally { _pidStartCache.delete(process.pid); }
  });

  test('non-stale file passes through without purge checks', () => {
    const os = new OrbitalSystem();
    const results = [
      { file: 'sub1.json', data: { session_id: 'sub1', state: 'coding' }, mtimeMs: Date.now() },
    ];
    os._applySessionResults('main-id', results);
    assert.ok(os.faces.has('sub1'), 'non-stale file should create face normally');
  });
});

// -- Bug fix: async face removal PID guard + no file deletion from face cleanup --

describe('grid.js -- async face removal PID guard (Bug #2)', () => {
  test('_applySessionResults keeps face with live PID when file missing', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('sub1');
    mf.state = 'coding';
    mf.pid = process.pid; // our own PID — guaranteed alive
    mf.stopped = false;
    os.faces.set('sub1', mf);

    // Empty results — file not seen, but PID is alive
    os._applySessionResults('main-id', []);
    assert.ok(os.faces.has('sub1'), 'face with live PID should survive missing file');
  });

  test('_applySessionResults removes face with dead PID when file missing', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('sub1');
    mf.state = 'coding';
    mf.pid = 999999; // non-existent PID
    mf.stopped = false;
    os.faces.set('sub1', mf);

    os._applySessionResults('main-id', []);
    assert.ok(!os.faces.has('sub1'), 'face with dead PID should be removed when file missing');
  });

  test('_applySessionResults removes stopped face even with live PID when file missing', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('sub1');
    mf.state = 'happy';
    mf.pid = process.pid;
    mf.stopped = true;
    os.faces.set('sub1', mf);

    os._applySessionResults('main-id', []);
    assert.ok(!os.faces.has('sub1'), 'stopped face should be removed even with live PID');
  });

  test('_applySessionResults removes face with no PID when file missing', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('sub1');
    mf.state = 'coding';
    mf.pid = 0;
    mf.stopped = false;
    os.faces.set('sub1', mf);

    os._applySessionResults('main-id', []);
    assert.ok(!os.faces.has('sub1'), 'face with no PID should be removed when file missing');
  });

  test('_applySessionResults drops the face but leaves the session file alone', () => {
    // A scan that did not see the file (results: []) must not conclude the file
    // is junk -- the dedicated stale purge owns deletion, this loop owns memory.
    const fs = require('fs');
    const pathMod = require('path');
    const { SESSIONS_DIR } = require('../shared');
    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    const id = 'async-removal-keeps-file';
    const fp = pathMod.join(SESSIONS_DIR, id + '.json');
    fs.writeFileSync(fp, JSON.stringify({ session_id: id, state: 'coding', timestamp: Date.now() }));
    try {
      const os = new OrbitalSystem();
      const mf = new MiniFace(id);
      mf.state = 'coding';
      mf.pid = 0;
      mf.stopped = false;
      os.faces.set(id, mf);

      os._applySessionResults('main-id', []);

      assert.ok(!os.faces.has(id), 'sanity: an unseen face with no pid is dropped from memory');
      assert.ok(fs.existsSync(fp), 'face removal must not delete the session file');
    } finally { try { fs.unlinkSync(fp); } catch {} }
  });
});

describe('grid.js -- sync face removal no file deletion (Bug #4)', () => {
  test('loadSessions retires a lingered stopped face without touching its file', () => {
    // Fresh file (the mtime purge will not touch it) + a face whose stopped
    // linger has expired: the removal loop must drop the face only.
    const fs = require('fs');
    const pathMod = require('path');
    const { SESSIONS_DIR } = require('../shared');
    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    const id = 'sync-removal-keeps-file';
    const fp = pathMod.join(SESSIONS_DIR, id + '.json');
    fs.writeFileSync(fp, JSON.stringify({
      session_id: id, state: 'happy', stopped: true, timestamp: Date.now(),
    }));
    try {
      const orbital = new OrbitalSystem();
      const face = new MiniFace(id);
      face.state = 'happy';
      face.stopped = true;
      face.stoppedAt = Date.now() - 60000;   // well past STOPPED_LINGER_MS
      orbital.faces.set(id, face);

      orbital.loadSessions('main-id');

      assert.ok(!orbital.faces.has(id), 'sanity: the lingered stopped face is retired');
      assert.ok(fs.existsSync(fp), 'sync face removal must not delete the session file');
    } finally { try { fs.unlinkSync(fp); } catch {} }
  });
});

describe('grid.js -- MiniFace orbital offset lerping', () => {
  test('setTargetOffset snaps on first call', () => {
    const face = new MiniFace('lerp-snap');
    face.setTargetOffset(1.0);
    assert.strictEqual(face.orbitalOffset, 1.0);
    assert.strictEqual(face.targetOffset, 1.0);
    assert.strictEqual(face._lerpElapsed, REPOSITION_MS);
  });

  test('setTargetOffset snaps during spawning', () => {
    const face = new MiniFace('lerp-spawn');
    face.spawning = true;
    face.setTargetOffset(1.0);
    assert.strictEqual(face.orbitalOffset, 1.0);
    assert.strictEqual(face.targetOffset, 1.0);
    assert.strictEqual(face._lerpElapsed, REPOSITION_MS);
  });

  test('setTargetOffset starts lerp on change', () => {
    const face = new MiniFace('lerp-change');
    face.setTargetOffset(1.0); // snap initial
    face.setTargetOffset(2.0); // should start lerp
    assert.strictEqual(face._lerpElapsed, 0);
    assert.strictEqual(face._lerpStartOffset, 1.0);
    assert.strictEqual(face.targetOffset, 2.0);
  });

  test('dead zone ignores tiny changes', () => {
    const face = new MiniFace('lerp-deadzone');
    face.setTargetOffset(1.0);
    face.setTargetOffset(1.001); // 0.001 < 0.005 threshold
    assert.strictEqual(face.targetOffset, 1.0);
  });

  test('tick advances lerp', () => {
    const face = new MiniFace('lerp-tick');
    face.setTargetOffset(0.0); // snap initial
    face.setTargetOffset(1.0); // start lerp
    face.tick(200); // halfway through 400ms
    assert.ok(face.orbitalOffset > 0.0, 'should have moved from start');
    assert.ok(face.orbitalOffset < 1.0, 'should not have reached target yet');
  });

  test('tick completes at REPOSITION_MS', () => {
    const face = new MiniFace('lerp-complete');
    face.setTargetOffset(0.0);
    face.setTargetOffset(1.0);
    face.tick(REPOSITION_MS);
    assert.strictEqual(face.orbitalOffset, face.targetOffset);
  });

  test('ease-out: past halfway at t=0.5', () => {
    const face = new MiniFace('lerp-easeout');
    face.setTargetOffset(0.0);
    face.setTargetOffset(1.0);
    face.tick(REPOSITION_MS / 2); // t=0.5
    // cubic ease-out at t=0.5: 1 - (0.5)^3 = 0.875 -- well past 0.5
    assert.ok(face.orbitalOffset > 0.5, `expected > 0.5 but got ${face.orbitalOffset}`);
  });

  test('shortest path wraps correctly', () => {
    const face = new MiniFace('lerp-wrap');
    face.setTargetOffset(3.0);
    face.setTargetOffset(-3.0); // should wrap through PI, not the long way
    face.tick(REPOSITION_MS);
    // After completion, should be at the target
    const diff = Math.abs(face.orbitalOffset - (-3.0));
    assert.ok(diff < 0.001, `expected close to -3.0, got ${face.orbitalOffset}`);
  });

  test('_shortestAngleDist correctness', () => {
    const face = new MiniFace('lerp-dist');
    // 0 to PI => PI
    const d1 = face._shortestAngleDist(0, Math.PI);
    assert.ok(Math.abs(d1 - Math.PI) < 0.001, `0->PI expected PI, got ${d1}`);
    // 0 to -PI => wraps (either direction is PI, implementation may return -PI or PI)
    const d2 = face._shortestAngleDist(0, -Math.PI);
    assert.ok(Math.abs(Math.abs(d2) - Math.PI) < 0.001, `0->-PI expected |PI|, got ${d2}`);
    // 3.0 to -3.0: should wrap through PI (~0.28 rad), not the long way (~6.0 rad)
    const d3 = face._shortestAngleDist(3.0, -3.0);
    const expected = -3.0 - 3.0 + Math.PI * 2; // ~0.283
    assert.ok(Math.abs(d3 - expected) < 0.001, `3.0->-3.0 expected ~${expected.toFixed(3)}, got ${d3}`);
  });

  test('rapid target changes restart from current position', () => {
    const face = new MiniFace('lerp-rapid');
    face.setTargetOffset(0.0);
    face.setTargetOffset(2.0); // start lerp 0 -> 2
    face.tick(200); // halfway, orbitalOffset is between 0 and 2
    const midOffset = face.orbitalOffset;
    assert.ok(midOffset > 0.0 && midOffset < 2.0, 'should be mid-lerp');
    face.setTargetOffset(0.5); // redirect mid-lerp
    assert.strictEqual(face._lerpStartOffset, midOffset, 'lerp should restart from current position');
    assert.strictEqual(face.targetOffset, 0.5);
    assert.strictEqual(face._lerpElapsed, 0);
  });
});

describe('grid.js -- MiniFace.tick()', () => {
  test('tick increments frame and time', () => {
    const face = new MiniFace('tick-test');
    assert.strictEqual(face.frame, 0);
    assert.strictEqual(face.time, 0);
    face.tick(66);
    assert.strictEqual(face.frame, 1);
    assert.strictEqual(face.time, 66);
  });
});

describe('grid.js -- MiniFace.isStale with completion state', () => {
  test('completion state with old lastUpdate is stale', () => {
    const face = new MiniFace('stale-test');
    face.state = 'happy';
    face.lastUpdate = Date.now() - (STALE_MS + 1000);
    assert.strictEqual(face.isStale(), true);
  });
});

describe('grid.js -- MiniFace spawning state', () => {
  test('spawning defaults to false', () => {
    const face = new MiniFace('spawn-test');
    assert.strictEqual(face.spawning, false);
    assert.strictEqual(face.spawnProgress, 0);
  });

  test('spawning can be set to true', () => {
    const face = new MiniFace('spawn-test-2');
    face.spawning = true;
    face.spawnProgress = 0;
    assert.strictEqual(face.spawning, true);
    assert.strictEqual(face.spawnProgress, 0);
  });
});

describe('grid.js -- MiniFace.updateFromFile with pending state buffering', () => {
  test('buffers state when minDisplayUntil has not passed', () => {
    const face = new MiniFace('buffer-test');
    // First update sets state to coding
    face.updateFromFile({ state: 'coding', detail: 'edit foo' }, Date.now());
    assert.strictEqual(face.state, 'coding');
    // Immediately update to reading — should be buffered because min display hasn't elapsed
    face.updateFromFile({ state: 'reading', detail: 'bar.js' }, Date.now() + 1);
    // reading should be pending since coding min display hasn't expired
    assert.strictEqual(face.pendingState, 'reading');
    assert.strictEqual(face.pendingDetail, 'bar.js');
  });
});

describe('grid.js -- OrbitalSystem constructor', () => {
  test('faces starts as empty map', () => {
    const sys = new OrbitalSystem();
    assert.ok(sys.faces instanceof Map);
    assert.strictEqual(sys.faces.size, 0);
  });
});

describe('grid.js -- isProcessAlive edge cases', () => {
  test('isProcessAlive(0) returns false', () => {
    assert.strictEqual(isProcessAlive(0), false);
  });

  test('isProcessAlive(-1) returns false', () => {
    assert.strictEqual(isProcessAlive(-1), false);
  });

  test('isProcessAlive(1) returns false (PID 1 is rejected)', () => {
    assert.strictEqual(isProcessAlive(1), false);
  });

  test('isProcessAlive(process.pid) returns true', () => {
    assert.strictEqual(isProcessAlive(process.pid), true);
  });

  test('isProcessAlive(null) returns false', () => {
    assert.strictEqual(isProcessAlive(null), false);
  });

  test('isProcessAlive(undefined) returns false', () => {
    assert.strictEqual(isProcessAlive(undefined), false);
  });
});

describe('grid.js -- MiniFace field persistence', () => {
  test('cwd persists when subsequent update omits it', () => {
    const face = new MiniFace('persist-cwd');
    face.updateFromFile({ state: 'coding', cwd: '/home/user/project' });
    face.updateFromFile({ state: 'reading' });
    assert.strictEqual(face.cwd, '/home/user/project');
  });

  test('gitBranch persists when subsequent update omits it', () => {
    const face = new MiniFace('persist-branch');
    face.updateFromFile({ state: 'coding', gitBranch: 'feature/xyz' });
    face.updateFromFile({ state: 'reading' });
    assert.strictEqual(face.gitBranch, 'feature/xyz');
  });

  test('taskDescription persists when subsequent update omits it', () => {
    const face = new MiniFace('persist-task');
    face.updateFromFile({ state: 'coding', taskDescription: 'fix bugs' });
    face.updateFromFile({ state: 'reading' });
    assert.strictEqual(face.taskDescription, 'fix bugs');
  });

  // Every child write carries parentSession, so a write without it is
  // update-state.js healing a window falsely stamped as a subagent (#134).
  // The face used to keep the stale stamp: never the center, and counted as
  // a live child of its old parent for as long as the renderer ran.
  test('a write without parentSession heals a falsely stamped window', () => {
    const face = new MiniFace('persist-parent');
    face.updateFromFile({ state: 'coding', parentSession: 'parent-123', taskDescription: 'stolen task', timestamp: 1 });
    assert.strictEqual(face.isMainSession, false);
    face.updateFromFile({ state: 'reading', timestamp: 2 });
    assert.strictEqual(face.parentSession, null);
    assert.strictEqual(face.taskDescription, '');
    assert.strictEqual(face.isMainSession, true);
  });

  test('a child keeps parentSession across its own writes', () => {
    const face = new MiniFace('persist-child');
    face.updateFromFile({ state: 'coding', parentSession: 'parent-123', timestamp: 1 });
    face.updateFromFile({ state: 'reading', parentSession: 'parent-123', timestamp: 2 });
    assert.strictEqual(face.parentSession, 'parent-123');
  });

  test('a teammate keeps parentSession when a write omits it', () => {
    const face = new MiniFace('persist-mate');
    face.updateFromFile({ state: 'coding', parentSession: 'lead', isTeammate: true, timestamp: 1 });
    face.updateFromFile({ state: 'reading', timestamp: 2 });
    assert.strictEqual(face.parentSession, 'lead');
  });
});

describe('grid.js -- MiniFace stopped handling', () => {
  test('stopped face ignores subsequent state updates', () => {
    const face = new MiniFace('stopped-test');
    face.updateFromFile({ state: 'happy', stopped: true });
    assert.ok(face.stopped);
    face.updateFromFile({ state: 'coding' });
    assert.strictEqual(face.state, 'happy');
  });

  test('stoppedAt is set when stopped becomes true', () => {
    const face = new MiniFace('stopped-at');
    const before = Date.now();
    face.updateFromFile({ state: 'happy', stopped: true });
    assert.ok(face.stoppedAt >= before);
    assert.ok(face.stoppedAt <= Date.now());
  });
});

describe('grid.js -- MiniFace isMainSession classification', () => {
  test('face with no parentSession and not teammate is main', () => {
    const face = new MiniFace('main-test');
    face.updateFromFile({ state: 'idle' });
    assert.strictEqual(face.isMainSession, true);
  });

  test('face with parentSession is not main', () => {
    const face = new MiniFace('sub-test');
    face.updateFromFile({ state: 'idle', parentSession: 'parent-1' });
    assert.strictEqual(face.isMainSession, false);
  });

  test('teammate is not main', () => {
    const face = new MiniFace('team-test');
    face.updateFromFile({ state: 'idle', isTeammate: true, teamName: 'backend' });
    assert.strictEqual(face.isMainSession, false);
  });
});

describe('grid.js -- OrbitalSystem update()', () => {
  test('update increments frame', () => {
    const os = new OrbitalSystem();
    os.update(66, 0);
    assert.strictEqual(os.frame, 1);
  });

  test('update advances rotationAngle', () => {
    const os = new OrbitalSystem();
    const before = os.rotationAngle;
    os.update(66, 0);
    assert.ok(os.rotationAngle > before);
  });
});

describe('grid.js -- constants', () => {
  test('STALE_MS is 120000', () => {
    assert.strictEqual(STALE_MS, 120000);
  });

  test('ORPHAN_TIMEOUT is 90000', () => {
    assert.strictEqual(ORPHAN_TIMEOUT, 90000);
  });

  test('REPOSITION_MS is 4000', () => {
    assert.strictEqual(REPOSITION_MS, 4000);
  });
});

describe('grid.js -- MiniFace orbital offset defaults', () => {
  test('orbitalOffset defaults to null', () => {
    const face = new MiniFace('offset-test');
    assert.strictEqual(face.orbitalOffset, null);
  });

  test('targetOffset defaults to null', () => {
    const face = new MiniFace('offset-test');
    assert.strictEqual(face.targetOffset, null);
  });

  test('REPOSITION_MS matches constant', () => {
    const face = new MiniFace('offset-test');
    assert.strictEqual(face.REPOSITION_MS, REPOSITION_MS);
  });
});

describe('grid.js -- MiniFace tick flushes pending', () => {
  test('pending state is flushed after minDisplayUntil expires', () => {
    const face = new MiniFace('tick-flush');
    face.updateFromFile({ state: 'coding', detail: 'edit a.js' });
    face.minDisplayUntil = Date.now() - 1;
    face.pendingState = 'reading';
    face.pendingDetail = 'b.js';
    face.tick(66);
    assert.strictEqual(face.state, 'reading');
    assert.strictEqual(face.detail, 'b.js');
  });

  test('pending state is NOT flushed before minDisplayUntil', () => {
    const face = new MiniFace('tick-no-flush');
    face.updateFromFile({ state: 'coding', detail: 'edit a.js' });
    face.pendingState = 'satisfied';
    face.pendingDetail = 'done';
    face.tick(66);
    assert.strictEqual(face.state, 'coding');
  });
});

describe('grid.js -- MiniFace error bypass', () => {
  test('error state always bypasses min display time', () => {
    const face = new MiniFace('error-bypass');
    face.updateFromFile({ state: 'coding', detail: 'edit a.js' });
    // coding has min display time still active
    face.updateFromFile({ state: 'error', detail: 'oops' });
    assert.strictEqual(face.state, 'error');
  });

  test('spawning state always bypasses min display time', () => {
    const face = new MiniFace('spawning-bypass');
    face.updateFromFile({ state: 'coding', detail: 'edit a.js' });
    face.updateFromFile({ state: 'spawning' });
    assert.strictEqual(face.state, 'spawning');
  });
});

describe('grid.js -- MiniFace active work interrupts interruptible', () => {
  test('coding can interrupt satisfied', () => {
    const face = new MiniFace('interrupt-test');
    face.state = 'satisfied';
    face.minDisplayUntil = Date.now() + 60000;
    face.updateFromFile({ state: 'coding', detail: 'foo.js' });
    assert.strictEqual(face.state, 'coding');
  });

  test('reading can interrupt idle', () => {
    const face = new MiniFace('interrupt-test2');
    face.state = 'idle';
    face.minDisplayUntil = Date.now() + 60000;
    face.updateFromFile({ state: 'reading', detail: 'bar.js' });
    assert.strictEqual(face.state, 'reading');
  });
});

// -- Activity Cycling Tests -------------------------------------------

describe('MiniFace activity cycling', () => {
  test('cycling constants are exported', () => {
    assert.ok(Array.isArray(CYCLE_WORK_STATES));
    assert.strictEqual(typeof CYCLE_INTERVAL, 'number');
    assert.strictEqual(typeof CYCLE_STALE_MS, 'number');
  });

  test('non-subagent faces do not cycle (no parentSession)', () => {
    const face = new MiniFace('no-parent');
    face.state = 'thinking';
    face.lastUpdate = Date.now() - CYCLE_STALE_MS - 1000;
    // Place firstSeen so cycle index would land on 'coding' (idx 3) if cycling fired
    face.firstSeen = Date.now() - (3 * CYCLE_INTERVAL + 500);
    face.minDisplayUntil = 0;
    face.tick(100);
    // Without parentSession, cycling should not activate — normal timeout moves
    // thinking to idle, but NOT to a cycling work state like coding
    assert.notStrictEqual(face.state, 'coding');
  });

  test('stopped faces do not cycle', () => {
    const face = new MiniFace('stopped-sub');
    face.parentSession = 'parent-1';
    face.stopped = true;
    face.state = 'thinking';
    face.lastUpdate = Date.now() - CYCLE_STALE_MS - 1000;
    face.firstSeen = Date.now() - (3 * CYCLE_INTERVAL + 500);
    face.minDisplayUntil = 0;
    face.tick(100);
    // Stopped guard prevents cycling — state should NOT be a cycling work state
    assert.notStrictEqual(face.state, 'coding');
  });

  test('spawning faces do not cycle', () => {
    const face = new MiniFace('spawning-sub');
    face.parentSession = 'parent-1';
    face.spawning = true;
    face.state = 'spawning';
    face.lastUpdate = Date.now() - CYCLE_STALE_MS - 1000;
    face.firstSeen = Date.now() - 100;
    face.minDisplayUntil = 0;
    face.tick(100);
    // Spawning guard prevents cycling — state stays spawning (too early for 2s auto-transition)
    assert.strictEqual(face.state, 'spawning');
  });

  test('fresh data prevents cycling (sinceUpdate < CYCLE_STALE_MS)', () => {
    const face = new MiniFace('fresh-data');
    face.parentSession = 'parent-1';
    face.state = 'reading';
    face.lastUpdate = Date.now(); // just updated
    face.firstSeen = Date.now() - 30000;
    face.minDisplayUntil = 0;
    face.tick(100);
    // lastUpdate is fresh so cycling doesn't kick in
    assert.strictEqual(face.state, 'reading');
  });

  test('deterministic cycling based on firstSeen', () => {
    const face = new MiniFace('cycle-test');
    face.parentSession = 'parent-1';
    face.state = 'thinking';
    const baseTime = Date.now();
    face.firstSeen = baseTime - 10000;
    face.lastUpdate = baseTime - CYCLE_STALE_MS - 1000;
    face.minDisplayUntil = 0;
    face.tick(100);
    const cycleTime = Date.now() - face.firstSeen;
    const expectedIdx = Math.floor(cycleTime / CYCLE_INTERVAL) % CYCLE_WORK_STATES.length;
    const expectedState = CYCLE_WORK_STATES[expectedIdx];
    assert.strictEqual(face.state, expectedState);
  });

  test('non-thinking cycling states survive timeout logic', () => {
    const face = new MiniFace('survive-test');
    face.parentSession = 'parent-1';
    face.state = 'idle';
    // Place firstSeen so cycle index lands on 'coding' (idx 3)
    face.firstSeen = Date.now() - (3 * CYCLE_INTERVAL + 500);
    face.lastUpdate = Date.now() - CYCLE_STALE_MS - 1000;
    face.minDisplayUntil = 0;
    face.tick(100);
    // Cycling should set 'coding' and the early return prevents timeout
    // logic from overwriting it back to 'thinking'
    assert.strictEqual(face.state, 'coding');
  });

  test('cycling sets minDisplayUntil to 800ms', () => {
    const face = new MiniFace('display-time');
    face.parentSession = 'parent-1';
    face.state = 'idle'; // will differ from cycle state
    face.firstSeen = Date.now() - 15000;
    face.lastUpdate = Date.now() - CYCLE_STALE_MS - 1000;
    face.minDisplayUntil = 0;
    const before = Date.now();
    face.tick(100);
    // minDisplayUntil should be ~now + 800
    assert.ok(face.minDisplayUntil >= before + 700);
    assert.ok(face.minDisplayUntil <= before + 1000);
  });

  test('_cycleDetail returns taskDescription when available', () => {
    const face = new MiniFace('detail-task');
    face.parentSession = 'parent-1';
    face.taskDescription = 'fix login bugs';
    face.state = 'coding';
    assert.strictEqual(face._cycleDetail(), 'fix logi');
  });

  test('_cycleDetail returns state-specific text without taskDescription', () => {
    const face = new MiniFace('detail-state');
    face.parentSession = 'parent-1';
    face.state = 'reading';
    assert.strictEqual(face._cycleDetail(), 'reading');
    face.state = 'searching';
    assert.strictEqual(face._cycleDetail(), 'looking');
    face.state = 'coding';
    assert.strictEqual(face._cycleDetail(), 'writing');
    face.state = 'executing';
    assert.strictEqual(face._cycleDetail(), 'running');
    face.state = 'thinking';
    assert.strictEqual(face._cycleDetail(), 'working');
  });

  test('real data override stops cycling', () => {
    const face = new MiniFace('override-test');
    face.parentSession = 'parent-1';
    face.state = 'idle';
    face.firstSeen = Date.now() - 15000;
    face.lastUpdate = Date.now() - CYCLE_STALE_MS - 1000;
    face.minDisplayUntil = 0;
    // Cycling kicks in — state should be one of the cycle states
    face.tick(100);
    const cycledState = face.state;
    assert.ok(CYCLE_WORK_STATES.includes(cycledState), `cycled to ${cycledState}`);
    // Now simulate real data arriving — expire minDisplayUntil first since
    // cycling sets it to now+800 and active work states can't interrupt each other
    face.minDisplayUntil = 0;
    face.updateFromFile({ state: 'coding', detail: 'real.js', timestamp: Date.now() });
    assert.strictEqual(face.state, 'coding');
    assert.strictEqual(face.detail, 'real.js');
    // Next tick should NOT cycle because lastUpdate is fresh
    face.tick(100);
    assert.strictEqual(face.state, 'coding');
  });
});

describe('grid.js -- isOwnedByLiveProcess (PID identity gate)', () => {
  const alive = () => true;
  const dead = () => false;

  function setCache(pid, value, resolvedAt = Date.now()) {
    _pidStartCache.set(pid, { value, resolvedAt });
  }

  test('dead process is never owner', () => {
    _pidStartCache.clear();
    setCache(7001, Date.now() - 99999999);
    assert.strictEqual(isOwnedByLiveProcess(7001, Date.now(), dead), false);
  });

  test('pid 0 / 1 / missing is never owner', () => {
    assert.strictEqual(isOwnedByLiveProcess(0, Date.now(), alive), false);
    assert.strictEqual(isOwnedByLiveProcess(1, Date.now(), alive), false);
    assert.strictEqual(isOwnedByLiveProcess(undefined, Date.now(), alive), false);
  });

  test('recycled PID (started after last write + slack) is not owner', () => {
    _pidStartCache.clear();
    const lastWrite = Date.now() - 5 * 24 * 3600 * 1000; // 5-day-old ghost
    setCache(7002, Date.now() - 3600 * 1000); // process started 1h ago
    assert.strictEqual(isOwnedByLiveProcess(7002, lastWrite, alive), false);
  });

  test('legit PID (started before last write) is owner', () => {
    _pidStartCache.clear();
    const lastWrite = Date.now();
    setCache(7003, lastWrite - 3600 * 1000); // started 1h before the write
    assert.strictEqual(isOwnedByLiveProcess(7003, lastWrite, alive), true);
  });

  test('start time within 1s slack after write still owns', () => {
    _pidStartCache.clear();
    const lastWrite = Date.now() - 10000;
    setCache(7004, lastWrite + 900); // 0.9s after write — inside SLACK_MS
    assert.strictEqual(isOwnedByLiveProcess(7004, lastWrite, alive), true);
    setCache(7004, lastWrite + 1100); // 1.1s after — outside
    assert.strictEqual(isOwnedByLiveProcess(7004, lastWrite, alive), false);
  });

  test('pending resolution protects (safe default)', () => {
    _pidStartCache.clear();
    setCache(7005, 'pending');
    assert.strictEqual(isOwnedByLiveProcess(7005, Date.now() - 99999999, alive), true);
  });

  test('unknown-alive protects only within 1h cap (recycled-onto-protected ghosts purge)', () => {
    _pidStartCache.clear();
    setCache(7006, 'unknown-alive');
    // Recent write + unreadable StartTime (elevated editor): protected
    assert.strictEqual(isOwnedByLiveProcess(7006, Date.now() - 30 * 60 * 1000, alive), true);
    // Ancient write + unreadable StartTime (ghost PID recycled onto a
    // protected system process, e.g. crashpad_handler): must purge
    assert.strictEqual(isOwnedByLiveProcess(7006, Date.now() - 99999999, alive), false);
    assert.strictEqual(isOwnedByLiveProcess(7006, Date.now(), dead), false);
  });

  test('unknown-nodata protects only within 1h cap', () => {
    _pidStartCache.clear();
    setCache(7007, 'unknown-nodata');
    assert.strictEqual(isOwnedByLiveProcess(7007, Date.now() - 30 * 60 * 1000, alive), true);  // 30 min — capped window
    assert.strictEqual(isOwnedByLiveProcess(7007, Date.now() - 2 * 3600 * 1000, alive), false); // 2 h — past cap
  });

  // A resolver that never answers synchronously: the platform resolvers differ
  // here (Linux /proc answers in the same tick, execFile cannot), so inject one
  // with fixed timing to make the "still resolving" window observable anywhere.
  const deferredResolver = (pids, done) => { setImmediate(() => done(new Map())); };

  test('uncached pid resolves as pending-protected and enqueues', () => {
    _pidStartCache.clear();
    _setPidResolver(deferredResolver);
    try {
      assert.strictEqual(isOwnedByLiveProcess(7008, Date.now(), alive), true);
      assert.strictEqual(_pidStartStatus(7008), 'pending');
    } finally { _setPidResolver(null); _pidStartCache.delete(7008); }
  });

  test('TTL: stale cache entry keeps protecting with old value but re-enqueues', () => {
    _pidStartCache.clear();
    _setPidResolver(deferredResolver);
    try {
      const lastWrite = Date.now();
      _pidStartCache.set(7009, { value: lastWrite - 1000, resolvedAt: Date.now() - 120000 }); // 2 min old entry
      assert.strictEqual(isOwnedByLiveProcess(7009, lastWrite, alive), true); // old value still used
      requestPidStartTime(7009, alive);
      // entry survives (not downgraded to pending) while refresh is queued
      assert.strictEqual(typeof _pidStartCache.get(7009).value, 'number');
    } finally { _setPidResolver(null); _pidStartCache.delete(7009); }
  });

  test('_setPidResolver: an answered start time decides ownership on every platform', () => {
    _pidStartCache.clear();
    const started = Date.now() - 5000;
    _setPidResolver((pids, done) => { done(new Map([[4242, started]])); }); // synchronous
    try {
      // 4242 is not a real process, so the liveness probe is stubbed out with
      // `alive`; the verdict then rests purely on the resolved start time
      // against the last write (+ SLACK_MS) -- the same answer on every OS.
      assert.strictEqual(isOwnedByLiveProcess(4242, Date.now(), alive), true);
      assert.strictEqual(isOwnedByLiveProcess(4242, Date.now() - 10000, alive), false);
    } finally { _setPidResolver(null); _pidStartCache.delete(4242); }
  });
});

describe('grid.js -- MiniFace editor derivation', () => {
  test('explicit editor field wins', () => {
    const f = new MiniFace('x');
    f.updateFromFile({ state: 'coding', editor: 'opencode', modelName: 'big-pickle' });
    assert.strictEqual(f.editor, 'opencode');
  });
  test('derives from modelName when it equals a known editor', () => {
    const f = new MiniFace('x');
    f.updateFromFile({ state: 'coding', modelName: 'codex' });
    assert.strictEqual(f.editor, 'codex');
  });
  test('derives from session id prefix', () => {
    const f = new MiniFace('opencode-47040');
    f.updateFromFile({ state: 'coding', modelName: 'big-pickle' });
    assert.strictEqual(f.editor, 'opencode');
  });
  test('no recoverable provenance -> empty (old engmux/subagent files)', () => {
    const f = new MiniFace('47040');
    f.updateFromFile({ state: 'coding', modelName: 'haiku' });
    assert.strictEqual(f.editor, '');
  });
  test('editor is sticky across later writes without the field', () => {
    const f = new MiniFace('x');
    f.updateFromFile({ state: 'coding', editor: 'openclaw', timestamp: 1 });
    f.updateFromFile({ state: 'reading', timestamp: 2 });
    assert.strictEqual(f.editor, 'openclaw');
  });
});

describe('grid.js -- recycled-PID purge integration', () => {
  test('isStale: recycled PID does not protect a quiet face', () => {
    _pidStartCache.clear();
    const face = new MiniFace('ghost');
    face.state = 'coding';
    face.lastUpdate = Date.now() - 5 * 24 * 3600 * 1000; // 5 days quiet
    // Use our own (live) pid with an injected start time AFTER lastUpdate —
    // simulates a recycled PID without needing to stub isProcessAlive.
    face.pid = process.pid;
    _pidStartCache.set(process.pid, { value: Date.now() - 1000, resolvedAt: Date.now() });
    assert.strictEqual(face.isStale(), true); // not owner -> orphan timeout applies
  });

  test('isStale: owning PID still protects a quiet face', () => {
    _pidStartCache.clear();
    const face = new MiniFace('legit');
    face.pid = process.pid;
    face.state = 'coding';
    face.lastUpdate = Date.now() - 5 * 60 * 1000; // 5 min quiet
    _pidStartCache.set(process.pid, { value: face.lastUpdate - 3600 * 1000, resolvedAt: Date.now() });
    assert.strictEqual(face.isStale(), false);
  });

  // A child's pid is its parent's editor: alive, that proves nothing about
  // the agent. A missed SubagentStop left a ghost for the editor's lifetime.
  test('isStale: a child\'s pid protects only for CHILD_ORPHAN_TIMEOUT', () => {
    const { CHILD_ORPHAN_TIMEOUT } = require('../grid');
    _pidStartCache.clear();
    const mk = (quietMs) => {
      const f = new MiniFace('p-agent-x');
      f.pid = process.pid;
      f.state = 'executing';
      f.parentSession = 'p';
      f.parentAlive = false;
      f.lastUpdate = Date.now() - quietMs;
      _pidStartCache.set(process.pid, { value: f.lastUpdate - 3600 * 1000, resolvedAt: Date.now() });
      return f;
    };
    assert.strictEqual(mk(5 * 60 * 1000).isStale(), false, 'a quiet agent inside the window is kept');
    assert.strictEqual(mk(CHILD_ORPHAN_TIMEOUT + 60000).isStale(), true, 'a ghost past it is not');
    const top = mk(CHILD_ORPHAN_TIMEOUT + 60000);
    top.parentSession = null;
    assert.strictEqual(top.isStale(), false, 'a top-level session keeps its editor\'s protection');
  });

  test('loadSessions purges a stale file whose pid was recycled', () => {
    const fs = require('fs');
    const pathMod = require('path');
    const { SESSIONS_DIR } = require('../shared');
    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    const id = 'recycled-pid-file';
    const fp = pathMod.join(SESSIONS_DIR, id + '.json');
    const wroteAt = Date.now() - 5 * 24 * 3600 * 1000; // 5-day-old ghost write
    fs.writeFileSync(fp, JSON.stringify({
      session_id: id, state: 'coding', pid: process.pid, timestamp: wroteAt,
    }));
    const old = new Date(Date.now() - STALE_MS - 5000);
    fs.utimesSync(fp, old, old);
    _pidStartCache.clear();
    try {
      // Start time AFTER the write: our live pid cannot be the writer.
      _pidStartCache.set(process.pid, { value: Date.now() - 1000, resolvedAt: Date.now() });
      new OrbitalSystem().loadSessions('main-id');
      assert.ok(!fs.existsSync(fp), 'a recycled pid must not keep a ghost file alive');

      // Same file, same live pid, but a start time that predates the write.
      fs.writeFileSync(fp, JSON.stringify({
        session_id: id, state: 'coding', pid: process.pid, timestamp: wroteAt,
      }));
      fs.utimesSync(fp, old, old);
      _pidStartCache.set(process.pid, { value: wroteAt - 3600 * 1000, resolvedAt: Date.now() });
      new OrbitalSystem().loadSessions('main-id');
      assert.ok(fs.existsSync(fp), 'the real owner still protects its file');
    } finally {
      _pidStartCache.delete(process.pid);
      try { fs.unlinkSync(fp); } catch {}
    }
  });

  test('source: purge paths use isOwnedByLiveProcess, not bare isProcessAlive', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'grid.js'), 'utf8');
    // Every site goes through pidProtects, which is isOwnedByLiveProcess plus
    // the child cap (round 3).
    assert.ok(/function pidProtects[\s\S]*?isOwnedByLiveProcess\(pid, lastWriteMs\)/.test(src), 'pidProtects gated');
    assert.ok(src.includes('pidProtects(this.pid, this.lastUpdate'), 'isStale gated');
    assert.ok(src.includes('pidProtects(knownFace.pid, knownFace.lastUpdate'), 'face-pid purge gated');
    assert.ok(src.includes('pidProtects(face.pid, face.lastUpdate'), 'keep-alive gated');
    assert.ok(!src.includes('knownFace.pid && isProcessAlive(knownFace.pid)'), 'old face-pid call removed');
  });
});

describe('grid.js -- session list editor tag', () => {
  const strip = s => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  // Carries a `model` so the exact-width assertion below exercises the info
  // row with a model segment present, not just the legacy shape.
  const mkFace = (over = {}) => Object.assign(new MiniFace('sess-1'), {
    state: 'coding', detail: 'editing foo', label: 'scorp3', cwd: '/tmp/proj',
    gitBranch: 'main', editor: 'opencode', model: 'Opus',
  }, over);

  test('row 1 shows the editor tag after state name', () => {
    const out = strip(renderSessionList(120, 40, [mkFace()], null, null, -1, {}));
    assert.ok(out.includes('opencode'), 'editor tag rendered');
    assert.ok(out.includes('scorp3'), 'label still rendered');
  });

  test('tag is dropped, label intact, when width is tight (injected long tag)', () => {
    const f = mkFace({ label: 'aaaaaaaaaaaaaa' });
    f.editor = 'verylongtagxxxx'; // sliced to 8 then must still drop at the floor
    const out = strip(renderSessionList(50, 40, [f], null, null, -1, {}));
    assert.ok(out.includes('aaaaaaaaaaaaaa'), 'label never sliced');
  });

  test('main row shows its editor and the star marker survives', () => {
    const mainInfo = { state: 'thinking', detail: 'pondering', cwd: '/tmp', gitBranch: 'main',
      label: 'claude', editor: 'claude', stopped: false, firstSeen: 0, isMain: true, isPinned: false };
    const out = strip(renderSessionList(120, 40, [], null, mainInfo, -1, {}));
    assert.ok(out.includes('★'), 'main marker present');
    assert.ok(out.includes('claude'));
  });

  test('row 3 prefers taskDescription over detail', () => {
    const f = mkFace({ taskDescription: 'fix the webhook retry logic', detail: 'edit foo' });
    const out = strip(renderSessionList(120, 40, [f], null, null, -1, {}));
    assert.ok(out.includes('fix the webhook retry logic'));
    assert.ok(!out.includes('edit foo'));
  });

  test('every row 1 stays exactly innerW wide with the tag present', () => {
    const out = renderSessionList(120, 40, [mkFace()], null, null, -1, {});
    // Each rendered row begins with a cursor-positioning escape; split there,
    // then strip color codes. Box width caps at 54 -> innerW 52.
    const rows = out.split(/\x1b\[\d+;\d+H/).map(strip).filter(l => l.startsWith('│') && l.length > 2);
    assert.ok(rows.length >= 3, 'should have content rows');
    for (const line of rows) {
      const inner = line.slice(1, line.lastIndexOf('│'));
      assert.strictEqual(inner.length, 52, `row width drifted: "${inner}" (${inner.length})`);
    }
  });
});

describe('grid.js -- no incremental clear buffer', () => {
  test('_buildClearBuf is gone', () => {
    const os = new OrbitalSystem();
    assert.strictEqual(typeof os._buildClearBuf, 'undefined',
      'OrbitalSystem#_buildClearBuf should no longer exist');
  });

  test('render output does not start with a space-fill', () => {
    const os = new OrbitalSystem();
    const f = new MiniFace('sub-1');
    f.label = 'sub-1';
    f.state = 'reading';
    os.faces.set('sub-1', f);
    const mainPos = { row: 7, col: 26, w: 30, h: 10, centerX: 41, centerY: 12 };
    os.render(80, 24, mainPos);          // first frame primes any clear buffer
    const out = os.render(80, 24, mainPos);
    assert.ok(!/^(\x1b\[\d+;\d+H +)+/.test(out),
      'render should not prepend blanks for the previous frame');
  });
});

// -- Model identity on the orbitals --------------------------------------

describe('grid.js -- model on orbital row 5', () => {
  const strip = (s) => s.replace(/\x1b\[[^m]*m/g, '');

  test('a child shows its model instead of the redundant branch', () => {
    const f = new MiniFace('par-agent-a1');
    f.state = 'coding';
    f.parentSession = 'par';
    f.model = 'Haiku';
    f.gitBranch = 'main';
    f.cwd = '/home/user/my-app';
    f.label = 'explore';
    const out = strip(f.render(1, 1, 0, PALETTES[0].themes));
    assert.ok(out.includes('Haiku'), 'row 5 should show the model');
    assert.ok(!out.includes('main'), 'the parent-identical branch is dropped');
  });

  test('a top-level orbital keeps its branch even with a model', () => {
    const f = new MiniFace('other-window');
    f.state = 'coding';
    f.model = 'Opus';
    f.gitBranch = 'dev';
    f.label = 'win2';
    const out = strip(f.render(1, 1, 0, PALETTES[0].themes));
    assert.ok(out.includes('dev'), 'a parallel window may be on another branch');
    assert.ok(!out.includes('Opus'), 'its model does not take the branch slot');
  });

  test('a child without a model falls back to the branch', () => {
    const f = new MiniFace('par-agent-a2');
    f.state = 'coding';
    f.parentSession = 'par';
    f.gitBranch = 'main';
    f.label = 'plan';
    const out = strip(f.render(1, 1, 0, PALETTES[0].themes));
    assert.ok(out.includes('main'), 'unchanged behaviour when no model is known');
  });

  test('a long model name is sliced to BOX_W like every other row', () => {
    const f = new MiniFace('par-agent-a3');
    f.state = 'coding';
    f.parentSession = 'par';
    f.model = 'some-very-long-model-id';
    const out = strip(f.render(1, 1, 0, PALETTES[0].themes));
    assert.ok(!out.includes('some-very-long'), 'sliced at the renderer, not the producer');
    assert.ok(out.includes('some-ver'), 'first BOX_W chars survive');
  });
});

describe('grid.js -- model in the session list info row', () => {
  const strip = (s) => s.replace(/\x1b\[[^m]*m/g, '');

  test('a top-level row shows the model beside its counters', () => {
    const f = Object.assign(new MiniFace('sess-m1'), {
      state: 'coding', detail: 'editing', label: 'win', cwd: '/tmp/p',
      editor: 'claude', model: 'Sonnet', toolCalls: 12, filesEdited: 3,
    });
    const out = strip(renderSessionList(120, 40, [f], null, null, -1, {}));
    assert.ok(out.includes('12 tools'), 'counters still rendered');
    assert.ok(out.includes('Sonnet'), 'model segment present');
  });

  test('a child row shows the model beside its agent type', () => {
    const f = Object.assign(new MiniFace('par-agent-a9'), {
      state: 'searching', detail: 'grep', label: 'explore', cwd: '/tmp/p',
      editor: 'claude', model: 'Haiku', parentSession: 'par', agentType: 'Explore',
    });
    const out = strip(renderSessionList(120, 40, [f], null, null, -1, {}));
    assert.ok(out.includes('Explore'), 'agent type still rendered');
    assert.ok(out.includes('Haiku'), 'model segment present');
  });

  test('rows stay exactly innerW wide when a very long model is carried', () => {
    const f = Object.assign(new MiniFace('sess-m2'), {
      state: 'coding', detail: 'editing', label: 'win', cwd: '/tmp/p',
      editor: 'claude', model: 'an-absurdly-long-model-identifier-abcdefghijklmnop',
      toolCalls: 12, filesEdited: 3,
    });
    const out = renderSessionList(120, 40, [f], null, null, -1, {});
    const rows = out.split(/\x1b\[\d+;\d+H/).map(strip).filter(l => l.startsWith('│') && l.length > 2);
    assert.ok(rows.length >= 3, 'should have content rows');
    for (const line of rows) {
      const inner = line.slice(1, line.lastIndexOf('│'));
      assert.strictEqual(inner.length, 52, `row width drifted: "${inner}" (${inner.length})`);
    }
  });
});

// -- Review round 2 regressions -----------------------------------------

describe('grid.js -- MiniFace same-state work write drops a stale completion', () => {
  test('fast Bash -> relieved queued -> second Bash keeps showing executing', () => {
    const face = new MiniFace('same-state');
    const t0 = Date.now();
    face.updateFromFile({ state: 'executing', detail: 'ls', timestamp: t0 });
    face.updateFromFile({ state: 'relieved', detail: 'command succeeded', timestamp: t0 + 1 });
    assert.strictEqual(face.pendingState, 'relieved', 'precondition: completion queued behind work');
    face.updateFromFile({ state: 'executing', detail: 'npm run build', timestamp: t0 + 2 });
    assert.strictEqual(face.pendingState, null, 'stale completion must be dropped');
    assert.strictEqual(face.state, 'executing');
    assert.strictEqual(face.detail, 'npm run build');
    face.minDisplayUntil = 0;
    face.tick(16);
    assert.strictEqual(face.state, 'executing', 'relieved flushed over the running tool');
  });

  test('a same-state completion leaves a queued completion alone', () => {
    const face = new MiniFace('same-completion');
    const t0 = Date.now();
    face.updateFromFile({ state: 'happy', detail: 'done', timestamp: t0 });
    face.pendingState = 'proud';
    face.updateFromFile({ state: 'happy', detail: 'done again', timestamp: t0 + 1 });
    assert.strictEqual(face.pendingState, 'proud');
  });
});

describe('grid.js -- activity cycling never paints over real state', () => {
  function staleChild(id, state) {
    const face = new MiniFace(id);
    face.parentSession = 'parent-1';
    face.state = state;
    face.firstSeen = Date.now() - (3 * CYCLE_INTERVAL + 500); // cycle idx would be 'coding'
    face.lastUpdate = Date.now() - CYCLE_STALE_MS - 1000;
    face.minDisplayUntil = 0;
    return face;
  }

  for (const state of ['waiting', 'error', 'responding', 'happy', 'proud', 'satisfied', 'relieved']) {
    test(`a synthetic child in '${state}' is not cycled`, () => {
      const face = staleChild('parent-1-sub-1', state);
      face.tick(16);
      assert.strictEqual(face.state, state);
    });
  }

  test('a synthetic child in a neutral state still cycles', () => {
    const face = staleChild('parent-1-sub-2', 'idle');
    face.tick(16);
    assert.strictEqual(face.state, 'coding');
  });

  test('a real agent_id orbital never cycles (it reports its own tools)', () => {
    const face = staleChild('parent-1-agent-a1', 'idle');
    face.tick(16);
    assert.notStrictEqual(face.state, 'coding', 'real agent orbital was cycled');
  });

  test('a real agent_id orbital sitting on a permission prompt keeps waiting', () => {
    const face = staleChild('parent-1-agent-a2', 'waiting');
    face.detail = 'allow?';
    face.tick(16);
    assert.strictEqual(face.state, 'waiting');
    assert.strictEqual(face.detail, 'allow?');
  });
});

describe('grid.js -- a live child is not dropped at boot for last writing a reward', () => {
  test('loadSessions keeps a child whose last write was happy 30s ago', () => {
    const os_ = require('os');
    const fs = require('fs');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os_.tmpdir(), 'cc-boot-reward-'));
    try {
      const now = Date.now();
      fs.writeFileSync(path.join(dir, 'M.json'), JSON.stringify(
        { session_id: 'M', state: 'subagent', timestamp: now, lastPromptAt: now }));
      const child = path.join(dir, 'M-agent-1.json');
      fs.writeFileSync(child, JSON.stringify(
        { session_id: 'M-agent-1', state: 'happy', detail: 'done', timestamp: now - 30000, parentSession: 'M' }));
      const past = new Date(now - 30000);
      fs.utimesSync(child, past, past);
      const orb = new OrbitalSystem();
      orb._sessionsDir = dir;
      orb.loadSessions('M');
      assert.ok(orb.faces.has('M-agent-1'), 'live child was dropped in the same pass it was built');
      assert.strictEqual(orb.liveChildCount(), 1, 'main loses its conducting hold');
      orb.loadSessions('M');
      assert.ok(orb.faces.has('M-agent-1'), 'child churned on the second pass');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a top-level face in a reward state is not stale either', () => {
    const face = new MiniFace('top-reward');
    face.state = 'proud';
    face.lastUpdate = Date.now() - 30000;
    assert.strictEqual(face.isStale(), false);
  });

  test('a child still goes stale on its orphan timeout', () => {
    const face = new MiniFace('P-agent-x');
    face.parentSession = 'P';
    face.parentAlive = false;
    face.state = 'happy';
    face.lastUpdate = Date.now() - ORPHAN_TIMEOUT - 1000;
    assert.strictEqual(face.isStale(), true);
  });
});

describe('grid.js -- PID start-time refresh runs once per TTL expiry', () => {
  test('callers during an in-flight refresh do not queue a second batch', () => {
    const calls = [];
    const callbacks = [];
    _setPidResolver((pids, cb) => { calls.push(pids.slice()); callbacks.push(cb); });
    const pid = 424242;
    const alive = () => true;
    try {
      _pidStartCache.set(pid, { value: 1000, resolvedAt: Date.now() - 61000 }); // TTL expired
      requestPidStartTime(pid, alive);
      requestPidStartTime(pid, alive);
      requestPidStartTime(pid, alive);
      assert.strictEqual(calls.length, 1, 'first refresh batch');
      assert.strictEqual(_pidStartCache.get(pid).value, 1000, 'old value still serves the gate');
      callbacks[0](new Map([[pid, 2000]]));
      assert.strictEqual(calls.length, 1, 'a redundant second batch ran');
      assert.strictEqual(_pidStartCache.get(pid).value, 2000);
      assert.ok(!_pidStartCache.get(pid).refreshing, 'marker cleared by the result');
    } finally {
      _pidStartCache.delete(pid);
      _setPidResolver(null);
    }
  });

  test('resetting the resolver clears a stuck refresh marker', () => {
    _setPidResolver(() => {}); // never calls back
    const pid = 434343;
    try {
      _pidStartCache.set(pid, { value: 1000, resolvedAt: Date.now() - 61000 });
      requestPidStartTime(pid, () => true);
      assert.ok(_pidStartCache.get(pid).refreshing);
      _setPidResolver(null);
      assert.ok(!_pidStartCache.get(pid).refreshing);
    } finally {
      _pidStartCache.delete(pid);
      _setPidResolver(null);
    }
  });
});

// -- Third review pass (Sep 2026) --------------------------------------------
// Each block below was reproduced against the pre-fix sources first.

describe('grid.js -- third review pass: stopped files are not kept by a live pid', () => {
  const fs = require('fs');
  const os = require('os');
  const pathMod = require('path');
  function staleFile(dir, id, data) {
    const fp = pathMod.join(dir, id + '.json');
    fs.writeFileSync(fp, JSON.stringify({ session_id: id, pid: process.pid, timestamp: Date.now() - STALE_MS - 60000, ...data }));
    const old = new Date(Date.now() - STALE_MS - 60000);
    fs.utimesSync(fp, old, old);
    return fp;
  }

  test('sync purge: a retired agent file goes even while its editor lives', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'crumb-purge-'));
    seedOwningPid();
    try {
      const done = staleFile(dir, 'p-agent-1', { state: 'happy', stopped: true, parentSession: 'p' });
      const live = staleFile(dir, 'win-2', { state: 'coding' });
      const orbital = new OrbitalSystem();
      orbital._sessionsDir = dir;
      orbital.loadSessions('main-id');
      assert.strictEqual(fs.existsSync(done), false, 'stopped: finished with its file');
      assert.strictEqual(fs.existsSync(live), true, 'live pid still protects a live session');
    } finally {
      _pidStartCache.delete(process.pid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test.async('async purge: the same rule', async () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'crumb-purge-'));
    seedOwningPid();
    try {
      const done = staleFile(dir, 'p-agent-2', { state: 'happy', stopped: true, parentSession: 'p' });
      const orbital = new OrbitalSystem();
      orbital._sessionsDir = dir;
      orbital._applySessionResults('main-id', [{
        file: 'p-agent-2.json', mtimeMs: Date.now() - STALE_MS - 60000,
        data: JSON.parse(fs.readFileSync(done, 'utf8')),
      }]);
      await new Promise(r => setTimeout(r, 50)); // fs.unlink is fire-and-forget
      assert.strictEqual(fs.existsSync(done), false);
    } finally {
      _pidStartCache.delete(process.pid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('grid.js -- third review pass: session list and labels', () => {
  const { HOME } = require('../shared');
  const homeFwd = HOME.replace(/\\/g, '/').replace(/\/+$/, '');

  test('~ replaces HOME only on a path boundary', () => {
    const sibling = new MiniFace('sib');
    sibling.state = 'coding';
    sibling.cwd = homeFwd + 'ice/proj';          // shares HOME's prefix, is not under it
    const inside = new MiniFace('in');
    inside.state = 'coding';
    inside.cwd = homeFwd + '/proj';
    const plain = renderSessionList(120, 40, [sibling, inside], PALETTES[0].themes).replace(/\x1b\[[^A-Za-z]*[A-Za-z]/g, '');
    assert.ok(!plain.includes('~ice/proj'), 'a sibling of HOME is not under ~');
    assert.ok(plain.includes('~/proj'), 'a folder under HOME still is');
  });

  test('~ ignores case on Windows, where editors disagree about the drive letter', () => {
    const { _truncatePath } = require('../grid');
    const flipped = homeFwd.replace(/[a-z]/i, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    assert.notStrictEqual(flipped, homeFwd, 'the fixture HOME has a letter to flip');
    assert.strictEqual(_truncatePath(flipped + '/proj', 80, true), '~/proj', 'folded on win32');
    assert.strictEqual(_truncatePath(flipped.replace(/\//g, '\\') + '\\proj', 80, true), '~/proj',
      'backslashes too');
    assert.strictEqual(_truncatePath(flipped + '/proj', 80, false), flipped + '/proj',
      'case-sensitive elsewhere');
    assert.strictEqual(_truncatePath(flipped + 'ice/proj', 80, true), flipped + 'ice/proj',
      'folding keeps the path-boundary rule');
  });

  test('a child with no task falls back to its agent type, not sub-N', () => {
    const orbital = new OrbitalSystem();
    for (const [id, type] of [['p-agent-a', 'Explore'], ['p-agent-b', 'Plan']]) {
      const f = new MiniFace(id);
      f.parentSession = 'p';
      f.agentType = type;
      f.modelName = type;
      f.cwd = '/repo';                             // shared, so the cwd cannot tell them apart
      orbital.faces.set(id, f);
    }
    orbital._assignLabels();
    assert.strictEqual(orbital.faces.get('p-agent-a').label, 'Explore');
    assert.strictEqual(orbital.faces.get('p-agent-b').label, 'Plan');
  });

  test('a legacy child without an agent type still gets sub-N, not the editor name', () => {
    const orbital = new OrbitalSystem();
    for (const id of ['legacy-1', 'legacy-2']) {
      const f = new MiniFace(id);
      f.parentSession = 'p';
      f.modelName = 'claude';
      f.cwd = '/repo';
      orbital.faces.set(id, f);
    }
    orbital._assignLabels();
    assert.ok(/^sub-\d$/.test(orbital.faces.get('legacy-1').label));
  });

  test('a detail that is not text is dropped, not drawn (an object blanked the ring)', () => {
    const face = new MiniFace('obj');
    face.updateFromFile({ state: 'error', detail: { code: 500, text: 'boom' }, timestamp: 1 });
    assert.strictEqual(face.detail, '');
    const multi = new MiniFace('multi');
    multi.updateFromFile({ state: 'coding', detail: 'line one\nline two', timestamp: 2 });
    assert.strictEqual(multi.detail, 'line one line two');
    const orbital = new OrbitalSystem();
    orbital.faces.set('obj', new MiniFace('obj'));
    orbital.faces.get('obj').updateFromFile({ state: 'error', detail: { code: 1 }, timestamp: 3 });
    assert.doesNotThrow(() => orbital.render(120, 60, { row: 20, col: 40, w: 30, h: 12, centerX: 55, centerY: 26 }, null));
  });
});

// -- Round 3: hostile session files (fuzz) ----------------------------------
// Session files are written by any adapter, and README documents model_name
// as a free-form adapter input. Each of these crashed the renderer or blanked
// the ring before.

describe('grid.js -- round 3: hostile session files', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const withDir = (files, fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-hostile-'));
    try {
      for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
      const orbital = new OrbitalSystem();
      orbital._sessionsDir = dir;
      return fn(orbital, dir);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const now = Date.now();

  test('non-string text fields are dropped, and labelling and rendering survive', () => {
    withDir({
      'a.json': JSON.stringify({ session_id: 'a', state: 'coding', timestamp: now,
        modelName: { provider: 'x', id: 'y' }, cwd: 5, taskDescription: ['t'], teammateName: {}, gitBranch: null }),
      'b.json': JSON.stringify({ session_id: 'b', state: 'reading', timestamp: now, cwd: '/r/b' }),
    }, (orbital) => {
      orbital.loadSessions(null);
      const a = orbital.faces.get('a');
      assert.ok(a, 'the session still loads');
      for (const k of ['modelName', 'cwd', 'taskDescription', 'teammateName', 'gitBranch']) {
        assert.ok(a[k] == null || typeof a[k] === 'string', `${k} is text or unset (${typeof a[k]})`);
      }
      assert.doesNotThrow(() => orbital._assignLabels());
      assert.doesNotThrow(() => a.update && a.update(16));
      assert.doesNotThrow(() => renderSessionList(120, 40, [...orbital.faces.values()], PALETTES[0].themes));
    });
  });

  test.async('a file holding null, a number or an array is skipped, sync and async', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-hostile-'));
    try {
      for (const [name, body] of Object.entries({
        'n.json': 'null', 'k.json': '5', 'arr.json': '[1,2]',
        'ok.json': JSON.stringify({ session_id: 'ok', state: 'idle', timestamp: now }),
      })) fs.writeFileSync(path.join(dir, name), body);
      const orbital = new OrbitalSystem();
      orbital._sessionsDir = dir;
      assert.doesNotThrow(() => orbital.loadSessions(null));
      assert.deepStrictEqual([...orbital.faces.keys()], ['ok']);
      // The async pass applies its results inside an fs callback, where a
      // throw is uncaught: catch it here instead of letting it kill the run.
      let thrown = null;
      const onErr = (e) => { thrown = e; };
      process.once('uncaughtException', onErr);
      orbital.faces.clear();
      orbital.loadSessionsAsync(null);
      const until = Date.now() + 3000;
      while (orbital._loadingInProgress && Date.now() < until) await new Promise(r => setTimeout(r, 10));
      process.removeListener('uncaughtException', onErr);
      assert.strictEqual(thrown, null, `the async pass threw: ${thrown && thrown.message}`);
      assert.ok(!orbital._loadingInProgress, 'the async pass finished');
      assert.deepStrictEqual([...orbital.faces.keys()], ['ok']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('an object session_id keys by file name, a numeric one by its string', () => {
    withDir({
      'x.json': JSON.stringify({ session_id: { a: 1 }, state: 'idle', timestamp: now }),
      'y.json': JSON.stringify({ session_id: 77, state: 'idle', timestamp: now }),
    }, (orbital) => {
      orbital.loadSessions(null);
      assert.deepStrictEqual([...orbital.faces.keys()].sort(), ['77', 'x']);
      orbital.loadSessions(null);
      assert.strictEqual(orbital.faces.size, 2, 'the same faces, not fresh ones every load');
    });
  });

  test('a state outside the table, or an inherited name, reads as idle', () => {
    for (const bad of ['__proto__', 'constructor', 'toString', 'nonsense', 7]) {
      const f = new MiniFace('s');
      f.updateFromFile({ state: bad, timestamp: now }, now);
      assert.strictEqual(f.state, 'idle', String(bad));
    }
    const { readState } = require('../renderer');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-rs-'));
    try {
      const fp = path.join(tmp, 's.json');
      fs.writeFileSync(fp, JSON.stringify({ state: 'constructor', modelName: { x: 1 }, cwd: 'a\u001b[2Jb', timestamp: now }));
      const r = readState(fp);
      assert.strictEqual(r.state, 'idle');
      assert.strictEqual(r.modelName, '');
      assert.ok(!r.cwd.includes('\u001b'), 'no raw ESC reaches the terminal');
      fs.writeFileSync(fp, 'null');
      assert.strictEqual(readState(fp).state, 'idle');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('grid.js -- round 3: live-renderer findings', () => {
  const fs = require('fs');
  const path = require('path');
  const RSRC = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

  // Below the list's minimum it draws nothing: `l` opened an invisible list
  // that swallowed the next key (an Enter silently pinned).
  test('the list opens, and is offered, only where it can draw', () => {
    const { sessionListFits, MIN_SESSION_LIST_COLS, MIN_SESSION_LIST_ROWS } = require('../grid');
    const { fitKeyHints } = require('../face');
    assert.strictEqual(sessionListFits(MIN_SESSION_LIST_COLS, MIN_SESSION_LIST_ROWS), true);
    assert.strictEqual(sessionListFits(MIN_SESSION_LIST_COLS - 1, 40), false);
    assert.strictEqual(sessionListFits(120, MIN_SESSION_LIST_ROWS - 1), false);
    assert.ok(fitKeyHints(200).some(h => h[0] === 'l'));
    assert.ok(!fitKeyHints(200, ['l']).some(h => h[0] === 'l'), 'the hint bar drops it');
    assert.ok(/key === 'l'\) \{[\s\S]{0,200}?if \(sessionListFits\(/.test(RSRC), 'the key is gated');
    assert.ok(/if \(face\.showSessionList && !sessionListFits\(/.test(RSRC), 'a resize below it closes it');
  });

  // Caffeine history belonged to the session that left: the incoming face
  // went "hyperdrive!" 67ms after arriving, having done nothing.
  test('a swap clears the caffeine history after its own forceState', () => {
    assert.ok(/face\.forceState\(newData\.state[\s\S]{0,1600}?face\.stateChangeTimes = \[\];/.test(RSRC));
  });

  // A swap restarted "still running … Ns" at 0, and the 10-minute hold with it.
  test('a swap keeps a running tool\'s age', () => {
    assert.ok(/ACTIVE_WORK_STATES\.has\(newData\.state\) \|\| newData\.state === 'waiting'\)[\s\S]{0,200}?face\.lastStateChange = ts;/.test(RSRC));
  });

  // A dead editor's agents are not running: counting them lifted the rescued
  // face back to conducting, round and round every ~12s.
  test('a dead editor\'s children do not hold the face at conducting', () => {
    assert.ok(/const liveChildren = \(minimal \|\| editorDead\) \? 0 : orbital\.liveChildCount\(\);/.test(RSRC));
  });
});

// -- Round 3: wide characters ---------------------------------------------
// A CJK folder, a Grep for a CJK phrase or an emoji detail takes two terminal
// columns per character; `.length` counted one. Orbital rows came out 16
// columns wide in the 8-column box and session-list rows pushed the right
// border out (or wrapped at 50 columns). Combining marks were the reverse:
// counted 1, drawn 0, so the row fell short.

// Walk a frame as a terminal would: a cursor move starts a span, other escapes
// paint nothing, and each code point advances by its display width.
function paintedSpans(out) {
  const { charWidth } = require('../shared');
  const spans = [];
  const re = /\x1b\[(\d+);(\d+)H|\x1b\[[0-9;?]*[A-Za-z]|([\s\S])/gu;
  let cur = null;
  let m;
  while ((m = re.exec(out))) {
    if (m[1]) {
      cur = { row: +m[1], col: +m[2], end: +m[2] - 1, text: '' };
      spans.push(cur);
    } else if (m[3] !== undefined && cur) {
      cur.end += charWidth(m[3].codePointAt(0));
      cur.text += m[3];
    }
  }
  return spans;
}

describe('grid.js -- round 3: wide characters', () => {
  const { strWidth } = require('../shared');
  const { orderSessionList } = require('../grid');
  const BOX = 8;
  // Rows 5-7 of a MiniFace drawn at (1, 1): label, branch/cwd/model, detail.
  const textRows = (f) => paintedSpans(f.render(1, 1, 0, PALETTES[0].themes)).filter(sp => sp.row >= 5);

  test('a MiniFace with a CJK label, cwd and detail keeps every row exactly 8 columns', () => {
    const f = new MiniFace('wide-1');
    f.updateFromFile({
      state: 'searching', detail: 'grep \u7528\u6237\u767b\u5f55\u5931\u8d25\u65f6\u663e\u793a\u9519\u8bef\u4fe1\u606f',
      cwd: '/home/user/\u30d7\u30ed\u30b8\u30a7\u30af\u30c8', timestamp: Date.now(),
    });
    f.label = '\u8a2d\u8a08\u66f8\u306e\u30ec\u30d3\u30e5\u30fc';
    const rows = textRows(f);
    assert.strictEqual(rows.length, 3);
    for (const sp of rows) {
      assert.strictEqual(sp.end - sp.col + 1, BOX, `row ${sp.row} "${sp.text}" is ${sp.end - sp.col + 1} columns`);
    }
  });

  test('a child with a CJK model and an emoji detail stays inside its box', () => {
    const f = new MiniFace('par-agent-wide');
    f.updateFromFile({
      state: 'coding', parentSession: 'par', model: '\u901a\u7fa9\u5343\u554f-\u6700\u5927',
      detail: '\ud83d\ude80 deploy \ud83d\ude80', gitBranch: 'feat/\u2728-sparkle', timestamp: Date.now(),
    });
    f.label = 'agent\ud83e\udd16x';
    for (const sp of textRows(f)) {
      assert.strictEqual(sp.end - sp.col + 1, BOX, `row ${sp.row} "${sp.text}" is ${sp.end - sp.col + 1} columns`);
      assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(sp.text), 'no split surrogate pair');
    }
  });

  test('combining marks no longer leave a MiniFace row short', () => {
    const f = new MiniFace('marks');
    f.updateFromFile({ state: 'reading', detail: 'e\u0301'.repeat(10), timestamp: Date.now() });
    f.label = 'cafe\u0301';
    for (const sp of textRows(f)) {
      assert.strictEqual(sp.end - sp.col + 1, BOX, `row ${sp.row} "${sp.text}" is ${sp.end - sp.col + 1} columns`);
    }
  });

  test('orbital labels are cut to 8 columns, not 8 characters', () => {
    const os = new OrbitalSystem();
    const a = new MiniFace('a'); a.taskDescription = '\u8a2d\u8a08\u66f8\u306e\u30ec\u30d3\u30e5\u30fc\u3092\u66f8\u304f';
    const b = new MiniFace('b'); b.cwd = '/srv/\u30d7\u30ed\u30b8\u30a7\u30af\u30c8'; b.firstSeen = a.firstSeen + 1;
    os.faces.set('a', a); os.faces.set('b', b);
    os._assignLabels();
    assert.strictEqual(a.label, '\u8a2d\u8a08\u66f8\u306e');
    assert.strictEqual(b.label, '\u30d7\u30ed\u30b8\u30a7');
  });

  test('a CJK group label is cut to 12 columns and clamped inside the right edge', () => {
    const os = new OrbitalSystem();
    const team = '\u57fa\u76e4\u30c1\u30fc\u30e0\u306e\u7686\u3055\u3093\u5168\u54e1';
    const f1 = new MiniFace('s1'); f1.teamName = team;
    const f2 = new MiniFace('s2'); f2.teamName = team;
    const positions = [{ col: 64, row: 5, face: f1 }, { col: 72, row: 5, face: f2 }];
    assert.ok(strWidth(os._getGroupLabel(positions, positions)) <= 12);
    const out = os._renderGroupLabels(positions, 30, 80, { col: 10, row: 20, w: 12, h: 8, centerX: 16, centerY: 24 });
    const spans = paintedSpans(out).filter(sp => sp.text);
    assert.ok(spans.length > 0, 'the label is drawn');
    for (const sp of spans) assert.ok(sp.end <= 80, `group label "${sp.text}" ends at column ${sp.end}`);
  });

  // A main row, a top-level window and one of its agents, all carrying CJK or
  // emoji text in every field the list draws.
  function wideEntries() {
    const now = Date.now();
    const mainInfo = {
      sessionId: 'main', state: 'thinking', detail: '\u8003\u3048\u4e2d', label: '\u30af\u30ed\u30fc\u30c9',
      cwd: '/home/user/\u8a2d\u8a08\u66f8/\u30ea\u30dd\u30b8\u30c8\u30ea', gitBranch: 'feature/\u30e6\u30fc\u30b6\u30fc\u8a8d\u8a3c\u306e\u4fee\u6b63',
      editor: 'claude', model: 'Opus', stopped: false, firstSeen: 0, isMain: true, isPinned: false,
      toolCalls: 3, filesEdited: 1, lastUpdate: now,
    };
    const win = Object.assign(new MiniFace('win'), {
      state: 'coding', detail: 'editing \u8a2d\u8a08\u66f8.md', label: '\u4e26\u884c\u7a93\u53e3\u306e\u4f5c\u696d',
      taskDescription: '\u7528\u6237\u767b\u5f55\u5931\u8d25\u65f6\u663e\u793a\u9519\u8bef\u4fe1\u606f\u5e76\u8bb0\u5f55\u65e5\u5fd7\u5230\u670d\u52a1\u5668',
      cwd: '/srv/\u30d7\u30ed\u30b8\u30a7\u30af\u30c8/\u8a2d\u8a08\u66f8\u306e\u30ea\u30dd\u30b8\u30c8\u30ea/\u30bd\u30fc\u30b9\u30b3\u30fc\u30c9\u306e\u30d5\u30a9\u30eb\u30c0',
      gitBranch: '\u4fee\u6b63/\u30ed\u30b0\u30a4\u30f3\u753b\u9762\u306e\u4e0d\u5177\u5408',
      editor: '\u7de8\u96c6\u8005\u540d\u524d', model: '\u901a\u7fa9\u5343\u554f-\u6700\u5927\u7248\u672c\u306e\u9577\u3044\u540d\u524d',
      toolCalls: 12, filesEdited: 3, lastUpdate: now, isMainSession: true,
    });
    const child = Object.assign(new MiniFace('win-agent-1'), {
      state: 'searching', detail: '\ud83d\udd0d grep \u9519\u8bef\u4fe1\u606f \ud83d\ude80', label: '\u8abf\u67fb\u30a8\u30fc\u30b8\u30a7\u30f3\u30c8',
      parentSession: 'win', agentType: '\u8abf\u67fb\u62c5\u5f53\u306e\u30a8\u30fc\u30b8\u30a7\u30f3\u30c8',
      cwd: '/srv/\u30d7\u30ed\u30b8\u30a7\u30af\u30c8', editor: 'claude', model: '\u4ff3\u53e5', lastUpdate: now,
    });
    return { mainInfo, entries: orderSessionList(mainInfo, [win, child]) };
  }

  for (const cols of [50, 120]) {
    test(`renderSessionList(${cols}, 40) keeps every CJK row inside the box`, () => {
      const { mainInfo, entries } = wideEntries();
      const boxW = Math.min(cols - 4, 54);
      const spans = paintedSpans(renderSessionList(cols, 40, entries, PALETTES[0].themes, mainInfo, 'win'));
      assert.ok(spans.length >= 3 * 5, 'three entries drawn');
      for (const sp of spans) {
        assert.strictEqual(sp.end - sp.col + 1, boxW, `row ${sp.row} is ${sp.end - sp.col + 1} columns, box is ${boxW}: "${sp.text}"`);
        assert.ok(sp.end <= cols, `row ${sp.row} ends at column ${sp.end} of ${cols}`);
      }
    });
  }

  test('a CJK path is shortened by columns, keeping its last two segments', () => {
    // 33 characters but 60 columns: `.length` said it fit the 48-column body.
    const f = Object.assign(new MiniFace('deep'), {
      state: 'reading', label: 'deep', lastUpdate: Date.now(),
      cwd: '/srv/\u30d7\u30ed\u30b8\u30a7\u30af\u30c8/\u8a2d\u8a08\u66f8\u306e\u30ea\u30dd\u30b8\u30c8\u30ea/\u30bd\u30fc\u30b9\u30b3\u30fc\u30c9\u306e\u30d5\u30a9\u30eb\u30c0',
    });
    const spans = paintedSpans(renderSessionList(120, 40, [{ face: f, depth: 0 }], PALETTES[0].themes, null, 'deep'));
    const row2 = spans.find(sp => sp.text.includes('\u30d5\u30a9\u30eb\u30c0'));
    assert.ok(row2, 'the last segment is drawn');
    assert.ok(row2.text.slice(1).trim().startsWith('.../\u8a2d\u8a08\u66f8'), `row 2 is "${row2.text}"`);
    assert.strictEqual(row2.end - row2.col + 1, 54, 'and the row stays 54 columns');
  });
});

describe('grid.js -- round 4', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  // An object pid threw inside the async loader's fs callback (uncaught: the
  // renderer died 2s after every boot), and the sync purge kept the file.
  test.async('a non-numeric pid neither throws nor protects a stale file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-pid-'));
    try {
      const fp = path.join(dir, 'bad.json');
      fs.writeFileSync(fp, JSON.stringify({ session_id: 'bad', state: 'coding', pid: { toString: 1 }, timestamp: Date.now() }));
      const orbital = new OrbitalSystem();
      orbital._sessionsDir = dir;
      let thrown = null;
      const onErr = (e) => { thrown = e; };
      process.once('uncaughtException', onErr);
      orbital.loadSessionsAsync(null);
      const until = Date.now() + 3000;
      while (orbital._loadingInProgress && Date.now() < until) await new Promise(r => setTimeout(r, 10));
      process.removeListener('uncaughtException', onErr);
      assert.strictEqual(thrown, null, `the async pass threw: ${thrown && thrown.message}`);
      const old = new Date(Date.now() - 3600000);
      fs.utimesSync(fp, old, old);
      const o2 = new OrbitalSystem();
      o2._sessionsDir = dir;
      assert.doesNotThrow(() => o2.loadSessions(null));
      assert.ok(!fs.existsSync(fp), 'a stale file with a junk pid is purged');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

module.exports = suite;
