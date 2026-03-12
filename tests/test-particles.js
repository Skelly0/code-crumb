#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - particles.js                             |
// +================================================================+

const assert = require('assert');
const { ParticleSystem } = require('../particles');

let passed = 0;
let failed = 0;
let currentDescribe = '';

function describe(name, fn) {
  currentDescribe = name;
  console.log(`\n  ${name}`);
  fn();
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    \x1b[32m\u2713\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`    \x1b[31m\u2717\x1b[0m ${name}`);
    console.log(`      ${e.message}`);
  }
}

describe('particles.js -- ParticleSystem', () => {
  test('starts with no particles', () => {
    const ps = new ParticleSystem();
    assert.strictEqual(ps.particles.length, 0);
  });

  test('spawn adds particles', () => {
    const ps = new ParticleSystem();
    ps.spawn(5, 'float');
    assert.strictEqual(ps.particles.length, 5);
  });

  test('all particle styles can be spawned', () => {
    const styles = ['float', 'sparkle', 'glitch', 'orbit', 'zzz', 'question', 'sweat', 'falling', 'speedline', 'echo', 'stream', 'heart', 'push', 'rain', 'fire'];
    for (const style of styles) {
      const ps = new ParticleSystem();
      ps.spawn(3, style);
      assert.strictEqual(ps.particles.length, 3, `spawn failed for style: ${style}`);
      for (const p of ps.particles) {
        assert.ok(typeof p.life === 'number', `particle.life missing for style: ${style}`);
        assert.ok(typeof p.char === 'string', `particle.char missing for style: ${style}`);
        assert.strictEqual(p.style, style);
      }
    }
  });

  test('update decrements particle life', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'float');
    const lifeBefore = ps.particles[0].life;
    ps.update();
    assert.strictEqual(ps.particles[0].life, lifeBefore - 1);
  });

  test('update removes dead particles', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'glitch');
    ps.particles[0].life = 1;
    ps.update();
    assert.strictEqual(ps.particles.length, 0);
  });

  test('fadeAll caps particle life', () => {
    const ps = new ParticleSystem();
    ps.spawn(5, 'float');
    ps.fadeAll(12);
    for (const p of ps.particles) {
      assert.ok(p.life <= 12);
    }
  });

  test('fire particles rise from below', () => {
    const ps = new ParticleSystem();
    ps.spawn(3, 'fire');
    assert.strictEqual(ps.particles.length, 3);
    ps.particles.forEach(p => {
      assert.ok(p.vy < 0, 'fire particles should rise (negative vy)');
      assert.strictEqual(p.style, 'fire');
    });
  });

  test('orbit particles move in circles', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'orbit');
    const p = ps.particles[0];
    const angleBefore = p.angle;
    ps.update();
    assert.notStrictEqual(p.angle, angleBefore);
  });
});

describe('particles.js -- velocity physics', () => {
  test('float particle moves by velocity on update', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'float');
    const p = ps.particles[0];
    const x0 = p.x, y0 = p.y;
    const vx = p.vx, vy = p.vy;
    ps.update();
    assert.ok(Math.abs((p.x - x0) - vx) < 0.001, 'x should move by vx');
    assert.ok(Math.abs((p.y - y0) - vy) < 0.001, 'y should move by vy');
  });

  test('sparkle particle moves by velocity on update', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'sparkle');
    const p = ps.particles[0];
    const x0 = p.x, y0 = p.y;
    const vx = p.vx, vy = p.vy;
    ps.update();
    assert.ok(Math.abs((p.x - x0) - vx) < 0.001, 'x should move by vx');
    assert.ok(Math.abs((p.y - y0) - vy) < 0.001, 'y should move by vy');
  });

  test('glitch particles have zero velocity', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'glitch');
    const p = ps.particles[0];
    assert.strictEqual(p.vx, 0);
    assert.strictEqual(p.vy, 0);
  });
});

describe('particles.js -- orbit physics', () => {
  test('orbit particle maintains constant radius', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'orbit');
    const p = ps.particles[0];
    const radius = p.radius;
    for (let i = 0; i < 10; i++) ps.update();
    // After update, position is computed from angle and radius
    const cx = ps.width / 2, cy = ps.height / 2;
    const actualR = Math.sqrt((p.x - cx) ** 2 + ((p.y - cy) / 0.45) ** 2);
    assert.ok(Math.abs(actualR - radius) < 0.5, `radius should stay ~${radius}, got ${actualR}`);
  });

  test('orbit angle increments each update', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'orbit');
    const p = ps.particles[0];
    const angles = [p.angle];
    for (let i = 0; i < 5; i++) {
      ps.update();
      angles.push(p.angle);
    }
    for (let i = 1; i < angles.length; i++) {
      assert.ok(angles[i] > angles[i - 1], `angle should increase: ${angles[i]} > ${angles[i-1]}`);
    }
  });
});

describe('particles.js -- lifecycle', () => {
  test('particle with life=3 is removed after 3 updates', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'float');
    ps.particles[0].life = 3;
    ps.update(); // life=2
    assert.strictEqual(ps.particles.length, 1);
    ps.update(); // life=1
    assert.strictEqual(ps.particles.length, 1);
    ps.update(); // life=0, removed
    assert.strictEqual(ps.particles.length, 0);
  });

  test('particle with life=1 is removed after 1 update', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'sparkle');
    ps.particles[0].life = 1;
    ps.update();
    assert.strictEqual(ps.particles.length, 0);
  });
});

describe('particles.js -- mixed styles', () => {
  test('float + orbit coexist and update correctly', () => {
    const ps = new ParticleSystem();
    ps.spawn(2, 'float');
    ps.spawn(2, 'orbit');
    assert.strictEqual(ps.particles.length, 4);
    const floats = ps.particles.filter(p => p.style === 'float');
    const orbits = ps.particles.filter(p => p.style === 'orbit');
    assert.strictEqual(floats.length, 2);
    assert.strictEqual(orbits.length, 2);
    // Record positions
    const fx0 = floats[0].x, oa0 = orbits[0].angle;
    ps.update();
    // Float moved by vx
    assert.notStrictEqual(floats[0].x, fx0);
    // Orbit angle changed
    assert.notStrictEqual(orbits[0].angle, oa0);
  });
});

describe('particles.js -- fadeAll edge cases', () => {
  test('fadeAll with value below current life caps it', () => {
    const ps = new ParticleSystem();
    ps.spawn(3, 'float');
    // All float particles have life > 60
    for (const p of ps.particles) {
      assert.ok(p.life > 5, 'initial life should be > 5');
    }
    ps.fadeAll(5);
    for (const p of ps.particles) {
      assert.strictEqual(p.life, 5, 'life should be capped at 5');
    }
  });

  test('fadeAll does not increase life', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'glitch');
    const p = ps.particles[0];
    const originalLife = p.life;
    ps.fadeAll(999);
    assert.strictEqual(p.life, originalLife, 'life should not increase');
  });
});

describe('particles.js -- spawn edge cases', () => {
  test('spawn count 0 adds no particles', () => {
    const ps = new ParticleSystem();
    ps.spawn(0, 'float');
    assert.strictEqual(ps.particles.length, 0);
  });

  test('spawn count 0 does not crash for any style', () => {
    const styles = ['float', 'sparkle', 'glitch', 'orbit', 'zzz', 'question', 'sweat', 'falling', 'speedline', 'echo', 'stream', 'heart', 'push', 'rain', 'fire'];
    for (const style of styles) {
      const ps = new ParticleSystem();
      ps.spawn(0, style);
      assert.strictEqual(ps.particles.length, 0, `spawn(0, '${style}') should produce no particles`);
    }
  });
});

describe('particles.js -- clearPrevious()', () => {
  test('returns empty string on a fresh ParticleSystem', () => {
    const ps = new ParticleSystem();
    assert.strictEqual(ps.clearPrevious(), '');
  });

  test('returns non-empty string after render()', () => {
    const ps = new ParticleSystem();
    ps.spawn(5, 'float');
    const savedRows = process.stdout.rows;
    const savedCols = process.stdout.columns;
    process.stdout.rows = 24;
    process.stdout.columns = 80;
    try {
      ps.render(0, 0, [255, 255, 255]);
      const clear = ps.clearPrevious();
      assert.ok(clear.length > 0, 'clearPrevious should return non-empty after render');
    } finally {
      process.stdout.rows = savedRows;
      process.stdout.columns = savedCols;
    }
  });

  test('second consecutive call returns empty (buffer consumed)', () => {
    const ps = new ParticleSystem();
    ps.spawn(5, 'float');
    const savedRows = process.stdout.rows;
    const savedCols = process.stdout.columns;
    process.stdout.rows = 24;
    process.stdout.columns = 80;
    try {
      ps.render(0, 0, [255, 255, 255]);
      ps.clearPrevious(); // first call consumes buffer
      const second = ps.clearPrevious();
      assert.strictEqual(second, '', 'second clearPrevious should return empty');
    } finally {
      process.stdout.rows = savedRows;
      process.stdout.columns = savedCols;
    }
  });
});

describe('particles.js -- render()', () => {
  test('render returns a string', () => {
    const ps = new ParticleSystem();
    ps.spawn(3, 'sparkle');
    const savedRows = process.stdout.rows;
    const savedCols = process.stdout.columns;
    process.stdout.rows = 24;
    process.stdout.columns = 80;
    try {
      const output = ps.render(0, 0, [255, 255, 255]);
      assert.strictEqual(typeof output, 'string');
    } finally {
      process.stdout.rows = savedRows;
      process.stdout.columns = savedCols;
    }
  });

  test('render output contains ANSI escape sequences', () => {
    const ps = new ParticleSystem();
    ps.spawn(5, 'float');
    const savedRows = process.stdout.rows;
    const savedCols = process.stdout.columns;
    process.stdout.rows = 24;
    process.stdout.columns = 80;
    try {
      const output = ps.render(0, 0, [255, 255, 255]);
      assert.ok(output.includes('\x1b['), 'output should contain ANSI escape sequences');
    } finally {
      process.stdout.rows = savedRows;
      process.stdout.columns = savedCols;
    }
  });

  test('_prevClearBuf is set after render', () => {
    const ps = new ParticleSystem();
    ps.spawn(5, 'float');
    const savedRows = process.stdout.rows;
    const savedCols = process.stdout.columns;
    process.stdout.rows = 24;
    process.stdout.columns = 80;
    try {
      ps.render(0, 0, [255, 255, 255]);
      assert.ok(ps._prevClearBuf.length > 0, '_prevClearBuf should be set after render');
    } finally {
      process.stdout.rows = savedRows;
      process.stdout.columns = savedCols;
    }
  });
});

describe('particles.js -- render boundary clipping', () => {
  test('out-of-bounds particles are not rendered', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'float');
    // Force particle far out of bounds
    ps.particles[0].x = -10;
    ps.particles[0].y = -10;
    const savedRows = process.stdout.rows;
    const savedCols = process.stdout.columns;
    process.stdout.rows = 24;
    process.stdout.columns = 80;
    try {
      const output = ps.render(0, 0, [255, 255, 255]);
      // The particle is at col=-10, row=-10, which is < 1, so it should be clipped
      assert.strictEqual(output, '', 'out-of-bounds particle should produce empty output');
      assert.strictEqual(ps._prevClearBuf, '', 'clearBuf should be empty for clipped particles');
    } finally {
      process.stdout.rows = savedRows;
      process.stdout.columns = savedCols;
    }
  });

  test('particle beyond terminal columns is clipped', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'float');
    ps.particles[0].x = 200;
    ps.particles[0].y = 5;
    const savedRows = process.stdout.rows;
    const savedCols = process.stdout.columns;
    process.stdout.rows = 24;
    process.stdout.columns = 80;
    try {
      const output = ps.render(0, 0, [255, 255, 255]);
      assert.strictEqual(output, '', 'particle beyond columns should be clipped');
    } finally {
      process.stdout.rows = savedRows;
      process.stdout.columns = savedCols;
    }
  });

  test('particle beyond terminal rows is clipped', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'float');
    ps.particles[0].x = 5;
    ps.particles[0].y = 200;
    const savedRows = process.stdout.rows;
    const savedCols = process.stdout.columns;
    process.stdout.rows = 24;
    process.stdout.columns = 80;
    try {
      const output = ps.render(0, 0, [255, 255, 255]);
      assert.strictEqual(output, '', 'particle beyond rows should be clipped');
    } finally {
      process.stdout.rows = savedRows;
      process.stdout.columns = savedCols;
    }
  });
});

describe('particles.js -- width/height properties', () => {
  test('default width is 40', () => {
    const ps = new ParticleSystem();
    assert.strictEqual(ps.width, 40);
  });

  test('default height is 14', () => {
    const ps = new ParticleSystem();
    assert.strictEqual(ps.height, 14);
  });

  test('setting width changes the value', () => {
    const ps = new ParticleSystem();
    ps.width = 60;
    assert.strictEqual(ps.width, 60);
  });

  test('setting height changes the value', () => {
    const ps = new ParticleSystem();
    ps.height = 20;
    assert.strictEqual(ps.height, 20);
  });
});

describe('particles.js -- multiple fadeAll calls', () => {
  test('fadeAll(10) then fadeAll(5) caps all lives at 5', () => {
    const ps = new ParticleSystem();
    ps.spawn(5, 'float');
    ps.fadeAll(10);
    for (const p of ps.particles) {
      assert.ok(p.life <= 10, 'after fadeAll(10) life should be <= 10');
    }
    ps.fadeAll(5);
    for (const p of ps.particles) {
      assert.ok(p.life <= 5, 'after fadeAll(5) life should be <= 5');
    }
  });

  test('fadeAll(100) after fadeAll(5) does not increase life', () => {
    const ps = new ParticleSystem();
    ps.spawn(5, 'float');
    ps.fadeAll(5);
    const livesBefore = ps.particles.map(p => p.life);
    ps.fadeAll(100);
    for (let i = 0; i < ps.particles.length; i++) {
      assert.strictEqual(ps.particles[i].life, livesBefore[i],
        'fadeAll with higher value should not increase life');
    }
  });
});

describe('particles.js -- unknown style is silently ignored', () => {
  test('spawn with unknown style adds 0 particles', () => {
    const ps = new ParticleSystem();
    ps.spawn(3, 'nonexistent_style');
    assert.strictEqual(ps.particles.length, 0,
      'unknown style should not add any particles');
  });

  test('spawn with another unknown style adds 0 particles', () => {
    const ps = new ParticleSystem();
    ps.spawn(5, 'totally_fake');
    assert.strictEqual(ps.particles.length, 0);
  });
});

describe('particles.js -- particle maxLife property', () => {
  test('all styles have positive maxLife', () => {
    const styles = ['float', 'sparkle', 'glitch', 'orbit', 'zzz', 'question', 'sweat', 'falling', 'speedline', 'echo', 'stream', 'heart', 'push', 'rain', 'fire'];
    for (const style of styles) {
      const ps = new ParticleSystem();
      ps.spawn(1, style);
      const p = ps.particles[0];
      assert.ok(typeof p.maxLife === 'number', `maxLife should be a number for style: ${style}`);
      assert.ok(p.maxLife > 0, `maxLife should be positive for style: ${style}, got ${p.maxLife}`);
    }
  });

  test('maxLife is greater than or equal to initial life for all styles', () => {
    const styles = ['float', 'sparkle', 'glitch', 'orbit', 'zzz', 'question', 'sweat', 'falling', 'speedline', 'echo', 'stream', 'heart', 'push', 'rain', 'fire'];
    for (const style of styles) {
      const ps = new ParticleSystem();
      ps.spawn(1, style);
      const p = ps.particles[0];
      assert.ok(p.maxLife >= p.life,
        `maxLife (${p.maxLife}) should be >= life (${p.life}) for style: ${style}`);
    }
  });
});

describe('particles.js -- push style', () => {
  test('push particles have non-zero radial velocities', () => {
    const ps = new ParticleSystem();
    ps.spawn(10, 'push');
    for (const p of ps.particles) {
      assert.ok(p.vx !== 0 || p.vy !== 0,
        'push particles should have non-zero velocity');
    }
  });

  test('push particles use push-specific chars', () => {
    const pushChars = ['\u2191', '\u25c7', '\u25c6', '\u00b7', '\u25b7', '\u2197'];
    const ps = new ParticleSystem();
    ps.spawn(20, 'push');
    for (const p of ps.particles) {
      assert.ok(pushChars.includes(p.char),
        `push particle char '${p.char}' should be one of the push-specific chars`);
    }
  });

  test('push particles have style set to push', () => {
    const ps = new ParticleSystem();
    ps.spawn(3, 'push');
    for (const p of ps.particles) {
      assert.strictEqual(p.style, 'push');
    }
  });

  test('push particles radiate from center', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'push');
    const p = ps.particles[0];
    const cx = ps.width / 2;
    const cy = ps.height / 2;
    // Velocity should point away from center (same sign as displacement from center)
    const dx = p.x - cx;
    const dy = p.y - cy;
    // vx and dx should share the same sign (or be very close to 0)
    if (Math.abs(dx) > 0.5) {
      assert.ok(Math.sign(p.vx) === Math.sign(dx),
        'vx should point away from center');
    }
  });
});

module.exports = { passed: () => passed, failed: () => failed };
