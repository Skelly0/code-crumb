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
    const styles = ['float', 'sparkle', 'glitch', 'orbit', 'zzz', 'question', 'sweat', 'falling', 'speedline', 'echo', 'stream', 'heart', 'push', 'rain'];
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
    const styles = ['float', 'sparkle', 'glitch', 'orbit', 'zzz', 'question', 'sweat', 'falling', 'speedline', 'echo', 'stream', 'heart', 'push', 'rain'];
    for (const style of styles) {
      const ps = new ParticleSystem();
      ps.spawn(0, style);
      assert.strictEqual(ps.particles.length, 0, `spawn(0, '${style}') should produce no particles`);
    }
  });
});

module.exports = { passed: () => passed, failed: () => failed };
