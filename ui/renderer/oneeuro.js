'use strict';
/**
 * One-euro filter — PREVIEW ONLY.
 *
 * This mirrors the shape of the core's common/oneeuro.h so the sliders feel
 * honest in this window. It never touches real input; the core does that.
 * If the two ever disagree, the C implementation is the source of truth.
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
    this.xPrev = null;
    this.tPrev = null;
  }

  setParams(fmin, beta) { this.fmin = fmin; this.beta = beta; }

  reset() { this.x.reset(); this.dx.reset(); this.xPrev = null; this.tPrev = null; }

  filter(x, tSeconds) {
    const dt = this.tPrev === null ? 1 / 60 : Math.max(1e-4, tSeconds - this.tPrev);
    this.tPrev = tSeconds;

    const rate = this.xPrev === null ? 0 : (x - this.xPrev) / dt;
    this.xPrev = x;

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
