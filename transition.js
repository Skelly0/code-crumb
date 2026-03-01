'use strict';

// +================================================================+
// |  SwapTransition -- dissolve/swap/materialize animation state    |
// |  Pure state machine: frame counting + interpolation, no I/O    |
// +================================================================+

// -- Config --------------------------------------------------------
const DISSOLVE_FRAMES = 7;
const MATERIALIZE_FRAMES = 7;
const TOTAL_FRAMES = DISSOLVE_FRAMES + 1 + MATERIALIZE_FRAMES; // 15

// Brightness range during dim/brighten
const DIM_MIN = 0.15;
const DIM_MAX = 1.0;

// -- SwapTransition ------------------------------------------------
class SwapTransition {
  constructor() {
    this.active = false;
    this.fromId = null;
    this.toId = null;
    this.frame = 0;
    this.phase = 'idle'; // idle | dissolve | swap | materialize | done
  }

  start(fromId, toId) {
    this.active = true;
    this.fromId = fromId;
    this.toId = toId;
    this.frame = 0;
    this.phase = 'dissolve';
  }

  tick() {
    if (!this.active) return { phase: 'idle', progress: 0, done: true };

    this.frame++;

    if (this.frame <= DISSOLVE_FRAMES) {
      this.phase = 'dissolve';
      const progress = this.frame / DISSOLVE_FRAMES;
      return { phase: 'dissolve', progress, done: false };
    }

    if (this.frame === DISSOLVE_FRAMES + 1) {
      this.phase = 'swap';
      return { phase: 'swap', progress: 1, done: false };
    }

    const matFrame = this.frame - DISSOLVE_FRAMES - 1;
    if (matFrame <= MATERIALIZE_FRAMES) {
      this.phase = 'materialize';
      const progress = matFrame / MATERIALIZE_FRAMES;
      return { phase: 'materialize', progress, done: false };
    }

    // Animation complete
    this.phase = 'done';
    this.active = false;
    return { phase: 'done', progress: 1, done: true };
  }

  /**
   * Returns brightness multiplier (0..1) for the main face output.
   * dissolve: 1.0 → 0.15, materialize: 0.15 → 1.0, else 1.0
   */
  dimFactor() {
    if (!this.active) return DIM_MAX;

    if (this.phase === 'dissolve') {
      const progress = Math.min(this.frame / DISSOLVE_FRAMES, 1);
      return DIM_MAX - (DIM_MAX - DIM_MIN) * progress;
    }

    if (this.phase === 'swap') {
      return DIM_MIN;
    }

    if (this.phase === 'materialize') {
      const matFrame = this.frame - DISSOLVE_FRAMES - 1;
      const progress = Math.min(matFrame / MATERIALIZE_FRAMES, 1);
      return DIM_MIN + (DIM_MAX - DIM_MIN) * progress;
    }

    return DIM_MAX;
  }

  cancel() {
    this.active = false;
    this.phase = 'idle';
    this.frame = 0;
    this.fromId = null;
    this.toId = null;
  }
}

module.exports = {
  SwapTransition,
  DISSOLVE_FRAMES,
  MATERIALIZE_FRAMES,
  TOTAL_FRAMES,
  DIM_MIN,
  DIM_MAX,
};
