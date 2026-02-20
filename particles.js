'use strict';

// +================================================================+
// |  Particle system -- visual effects for the face renderer        |
// |  12 particle styles: float, sparkle, glitch, orbit, zzz,       |
// |  question, sweat, falling, speedline, echo, heart, push         |
// +================================================================+

const { ansi, dimColor } = require('./themes');

// -- ParticleSystem ------------------------------------------------
class ParticleSystem {
  constructor() {
    this.particles = [];
    this.width = 40;
    this.height = 14;
  }

  // Rapidly age all particles so they fade out on state change
  fadeAll(maxLife = 12) {
    for (const p of this.particles) {
      p.life = Math.min(p.life, maxLife);
    }
  }

  spawn(count, style = 'float') {
    for (let i = 0; i < count; i++) {
      if (style === 'float') {
        this.particles.push({
          x: Math.random() * this.width,
          y: Math.random() * this.height,
          vx: (Math.random() - 0.5) * 0.3,
          vy: -Math.random() * 0.2 - 0.05,
          life: 60 + Math.random() * 120,
          maxLife: 180,
          char: ['\u00b7', '\u2022', '\u2218', '\u00b0', '\u02da'][Math.floor(Math.random() * 5)],
          style,
        });
      } else if (style === 'sparkle') {
        const angle = Math.random() * Math.PI * 2;
        const dist = 8 + Math.random() * 6;
        this.particles.push({
          x: this.width / 2 + Math.cos(angle) * dist,
          y: this.height / 2 + Math.sin(angle) * dist * 0.5,
          vx: Math.cos(angle) * 0.15,
          vy: Math.sin(angle) * 0.08,
          life: 20 + Math.random() * 40,
          maxLife: 60,
          char: ['\u2726', '\u2727', '\u22b9', '\u00b7', '*'][Math.floor(Math.random() * 5)],
          style,
        });
      } else if (style === 'glitch') {
        this.particles.push({
          x: Math.random() * this.width,
          y: Math.random() * this.height,
          vx: 0, vy: 0,
          life: 3 + Math.random() * 8,
          maxLife: 11,
          char: ['\u2593', '\u2591', '\u2592', '\u2588', '\u2573', '\u256c'][Math.floor(Math.random() * 6)],
          style,
        });
      } else if (style === 'orbit') {
        const angle = Math.random() * Math.PI * 2;
        this.particles.push({
          x: 0, y: 0, angle,
          radius: 10 + Math.random() * 5,
          speed: 0.03 + Math.random() * 0.03,
          life: 80 + Math.random() * 60,
          maxLife: 140,
          char: ['\u25c6', '\u25c7', '\u00b7', '\u2022'][Math.floor(Math.random() * 4)],
          style,
        });
      } else if (style === 'zzz') {
        this.particles.push({
          x: this.width / 2 + 4 + Math.random() * 3,
          y: this.height / 2 - 2,
          vx: 0.04 + Math.random() * 0.04,
          vy: -0.08 - Math.random() * 0.04,
          life: 50 + Math.random() * 50,
          maxLife: 100,
          char: ['z', 'Z', 'z', '\u00b7'][Math.floor(Math.random() * 4)],
          style,
        });
      } else if (style === 'question') {
        this.particles.push({
          x: this.width / 2 + (Math.random() - 0.5) * 8,
          y: this.height / 2 - 3 - Math.random() * 2,
          vx: (Math.random() - 0.5) * 0.04,
          vy: -0.02 - Math.random() * 0.02,
          life: 40 + Math.random() * 40,
          maxLife: 80,
          char: ['?', '\u00b7', '?', '\u00b7'][Math.floor(Math.random() * 4)],
          style,
        });
      } else if (style === 'sweat') {
        this.particles.push({
          x: this.width / 2 + (Math.random() > 0.5 ? 1 : -1) * (7 + Math.random() * 2),
          y: this.height / 2 - 3,
          vx: (Math.random() - 0.5) * 0.08,
          vy: 0.15 + Math.random() * 0.1,
          life: 15 + Math.random() * 15,
          maxLife: 30,
          char: ['\u00b7', '\u2022', '\u00b0'][Math.floor(Math.random() * 3)],
          style,
        });
      } else if (style === 'falling') {
        this.particles.push({
          x: this.width / 4 + Math.random() * (this.width / 2),
          y: 0,
          vx: (Math.random() - 0.5) * 0.08,
          vy: 0.15 + Math.random() * 0.12,
          life: 50 + Math.random() * 30,
          maxLife: 80,
          char: ['\u00b7', '\u2022', '\u2218', '\u25cb'][Math.floor(Math.random() * 4)],
          style,
        });
      } else if (style === 'speedline') {
        const side = Math.random() > 0.5 ? 1 : -1;
        this.particles.push({
          x: this.width / 2 + side * (4 + Math.random() * 8),
          y: this.height / 2 - 2 + Math.random() * 4,
          vx: side * (0.3 + Math.random() * 0.2),
          vy: 0,
          life: 6 + Math.random() * 10,
          maxLife: 16,
          char: ['\u2500', '\u2501', '\u2550', '\u2500'][Math.floor(Math.random() * 4)],
          style,
        });
      } else if (style === 'echo') {
        const angle = Math.random() * Math.PI * 2;
        this.particles.push({
          x: this.width / 2 + Math.cos(angle) * (5 + Math.random() * 3),
          y: this.height / 2 + Math.sin(angle) * (2.5 + Math.random() * 1.5),
          vx: Math.cos(angle) * 0.06,
          vy: Math.sin(angle) * 0.03,
          life: 25 + Math.random() * 25,
          maxLife: 50,
          char: ['\u256d', '\u256e', '\u2570', '\u256f', '\u2502', '\u2500'][Math.floor(Math.random() * 6)],
          style,
        });
      } else if (style === 'stream') {
        // Particles radiate outward from face center — energy flowing to subagents
        const angle = Math.random() * Math.PI * 2;
        this.particles.push({
          x: this.width / 2,
          y: this.height / 2,
          vx: Math.cos(angle) * (0.2 + Math.random() * 0.15),
          vy: Math.sin(angle) * (0.1 + Math.random() * 0.08),
          life: 30 + Math.random() * 30,
          maxLife: 60,
          char: ['\u00b7', '\u2022', '\u2218', '\u00b7'][Math.floor(Math.random() * 4)],
          style,
        });
      } else if (style === 'heart') {
        const angle = Math.random() * Math.PI * 2;
        const dist = 5 + Math.random() * 9;
        this.particles.push({
          x: this.width / 2 + Math.cos(angle) * dist,
          y: this.height / 2 + Math.sin(angle) * dist * 0.5,
          vx: Math.cos(angle) * 0.2,
          vy: Math.sin(angle) * 0.1 - 0.06,
          life: 30 + Math.random() * 50,
          maxLife: 80,
          char: ['\u2665', '\u2661', '\u2665', '\u2661', '\u2764'][Math.floor(Math.random() * 5)],
          style,
        });
      } else if (style === 'push') {
        // Burst radially outward from face center — commit/push energy radiating out
        const angle = Math.random() * Math.PI * 2;
        const startR = 3 + Math.random() * 4;
        const speed  = 0.38 + Math.random() * 0.28;
        this.particles.push({
          x: this.width / 2 + Math.cos(angle) * startR,
          y: this.height / 2 + Math.sin(angle) * startR * 0.5,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed * 0.45,
          life: 16 + Math.random() * 22,
          maxLife: 38,
          char: ['\u2191', '\u25c7', '\u25c6', '\u00b7', '\u25b7', '\u2197'][Math.floor(Math.random() * 6)],
          style,
        });
      }
    }
  }

  update() {
    this.particles = this.particles.filter(p => {
      p.life--;
      if (p.style === 'orbit') {
        p.angle += p.speed;
        p.x = this.width / 2 + Math.cos(p.angle) * p.radius;
        p.y = this.height / 2 + Math.sin(p.angle) * p.radius * 0.45;
      } else {
        p.x += p.vx;
        p.y += p.vy;
      }
      return p.life > 0;
    });
  }

  render(offsetRow, offsetCol, accentColor) {
    let out = '';
    for (const p of this.particles) {
      const col = Math.round(p.x) + offsetCol;
      const row = Math.round(p.y) + offsetRow;
      if (row >= 1 && col >= 1 && row < process.stdout.rows && col < process.stdout.columns) {
        const fade = Math.min(1, p.life / (p.maxLife * 0.3));
        const color = dimColor(accentColor, fade);
        out += ansi.to(row, col) + ansi.fg(...color) + p.char;
      }
    }
    return out;
  }
}

module.exports = { ParticleSystem };
