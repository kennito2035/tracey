'use strict';
/**
 * One-euro filter, PREVIEW ONLY.
 *
 * Matches src/common/oneeuro.h including its deliberate quirk: the velocity
 * estimate is taken from the previous FILTERED output, not from the previous
 * raw sample (the canonical Casiez 2012 form). The core is non-canonical on
 * purpose, and every published number is measured against that variant, so
 * the pad must ship the same one or the sliders lie about the shipped feel.
 * If the two ever disagree, the C implementation is the source of truth:
 * change this file, never the header. Parity is enforced by tools/verify.js.
 * This never touches real input; the core does that.
 */

function alphaFor(cutoffHz, dt) {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
}

class LowPass {
  constructor() { this.s = null; }
  filter(x, alpha) {
    this.s = this.s === null ? x : alpha * x + (1 - alpha) * this.s;
    return this.s;
  }
  reset() { this.s = null; }
}

class OneEuro {
  constructor(fmin = 0.4, beta = 0.02, dCutoff = 1.0) {
    this.fmin = fmin;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.tPrev = null;
  }

  setParams(fmin, beta) { this.fmin = fmin; this.beta = beta; }

  reset() { this.x.reset(); this.dx.reset(); this.tPrev = null; }

  filter(x, tSeconds) {
    // A repeated or backwards timestamp returns the last output and changes
    // no state, matching oneeuro_filter's `if (dt <= 0.0) return f->x_prev;`.
    // Clamping dt to a tiny floor instead (what this used to do) fabricates a
    // huge rate, and the derivative low-pass then inflates the cutoff for
    // ~0.16 s afterwards. That is not academic: Chromium coalesces several
    // pointer samples per frame under one millisecond-resolution timeStamp,
    // so a mouse or a fast pen delivers dt = 0 constantly. Measured against
    // the core's form on a 6 Hz tremor stroke: 3.67 px mean divergence at
    // Steadiest with the floor, 0 without it.
    if (this.tPrev !== null && tSeconds - this.tPrev <= 0) {
      return this.x.s === null ? x : this.x.s;
    }
    const dt = this.tPrev === null ? 1 / 60 : tSeconds - this.tPrev;
    this.tPrev = tSeconds;

    // Velocity from the previous FILTERED output, read before this.x.filter()
    // overwrites it. Deliberately not the canonical previous-raw-sample form:
    // see the header comment.
    const prev = this.x.s;
    const rate = prev === null ? 0 : (x - prev) / dt;

    const edx = this.dx.filter(rate, alphaFor(this.dCutoff, dt));
    const cutoff = this.fmin + this.beta * Math.abs(edx);
    return this.x.filter(x, alphaFor(cutoff, dt));
  }
}

/** Two independent 1-D filters, one per axis — same as the core. */
class OneEuro2D {
  constructor(fmin, beta) {
    this.fx = new OneEuro(fmin, beta);
    this.fy = new OneEuro(fmin, beta);
  }
  setParams(fmin, beta) { this.fx.setParams(fmin, beta); this.fy.setParams(fmin, beta); }
  reset() { this.fx.reset(); this.fy.reset(); }
  filter(x, y, t) { return [this.fx.filter(x, t), this.fy.filter(y, t)]; }
}
