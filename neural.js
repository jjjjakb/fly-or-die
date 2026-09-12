/* FLY OR DIE — biologically-inspired spiking model of the fly escape circuit.
 *
 * This is NOT a recording from the MCNS connectome. It is a small, real
 * leaky-integrate-and-fire network wired to mirror the logic of the
 * Drosophila giant-fibre escape response:
 *
 *   looming-sensitive visual neurons (LC4 / LPLC2)
 *        -> local interneurons
 *        -> descending neurons (DNa / DNb)
 *        -> giant fibre (GF)            <- fast, myelinated-like escape line
 *        -> flight / leg motor neurons
 *
 * A slow adaptation current on the sensory->GF pathway gives the network
 * habituation: repeated near-misses raise the trigger threshold, which is
 * the real reason a fly eventually stops flinching at a waving hand.
 */
(function (global) {
  'use strict';

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const GROUPS = {
    sensory: { color: '#3ad2ff', label: 'sensory' },
    local: { color: '#8a6bff', label: 'interneuron' },
    descending: { color: '#ffab2e', label: 'descending' },
    giantfiber: { color: '#ff2e88', label: 'giant fibre' },
    motor: { color: '#8dff6b', label: 'motor' },
  };

  const SENSORY = [
    ['LC4a', 'loom'], ['LC4b', 'loom'], ['LC4c', 'loom'], ['LPLC2', 'loom'],
    ['LC6', 'loom'], ['H1', 'motion'], ['VCH', 'wind'], ['JO', 'wind'],
  ];
  const LOCAL_CLUSTERS = ['LPU', 'PVLP', 'AVLP', 'SMP', 'CRE', 'WED', 'LAL', 'IB', 'FB', 'MB'];
  const DESC = ['DNa01', 'DNa02', 'DNb01', 'DNb02', 'DNp09', 'DNp11', 'DNg11', 'DNg13', 'DNc01', 'DNe01'];
  const GF = ['GF_L', 'GF_R'];
  const MOTOR = [
    ['wing_L', 'wing'], ['wing_R', 'wing'],
    ['leg_L', 'leg'], ['leg_R', 'leg'],
    ['haltere_L', 'wing'], ['haltere_R', 'wing'],
    ['neck_L', 'neck'], ['neck_R', 'neck'],
    ['abdo_L', 'neck'], ['abdo_R', 'neck'],
  ];

  class FlyNet {
    constructor(seed) {
      this.rand = mulberry32(seed || 1337);
      this.time = 0;                 // simulated ms
      this.neurons = [];
      this.synapses = [];
      this.pending = [];
      this.spikeLog = [];            // {i, t} recent spikes for the raster
      this.gfSpikes = 0;
      this.gfEvent = null;           // 'L' | 'R' | null consumed by the game
      this.sensorDrive = 0;          // smoothed loom drive, read by the HUD

      this.vrest = -65;
      this.vth = -50;
      this.vreset = -70;
      this.tau = 18;
      this.tauSyn = 8;
      this.trefMs = 2.4;
      this.adaptTau = 120;
      this.adaptGain = 10;

      this._build();
    }

    _addNeuron(name, group, role, nx, ny, opts) {
      const n = Object.assign({
        i: this.neurons.length,
        name, group, role, nx, ny,
        v: this.vrest + (this.rand() - 0.5) * 4,
        I: 0, a: 0, tref: 0,
        adaptGain: this.adaptGain,
        rate: 0, spikes: 0, last: -1e9,
        out: [], in: [],
      }, opts || {});
      this.neurons.push(n);
      return n;
    }

    _connect(pre, post, w, delay) {
      const s = { pre: pre.i, post: post.i, w, delay: delay == null ? 1.6 : delay, pulse: 0 };
      this.synapses.push(s);
      this.neurons[pre.i].out.push(s);
      this.neurons[post.i].in.push(s);
      return s;
    }

    _build() {
      const R = this.rand;
      const layers = {
        sensory: 0.09, local: 0.36, descending: 0.68, giantfiber: 0.83, motor: 0.95,
      };
      const place = (group, count, spread) => {
        const arr = [];
        for (let k = 0; k < count; k++) {
          const ny = spread[0] + (count === 1 ? 0 : (k / (count - 1))) * (spread[1] - spread[0]);
          arr.push({ nx: layers[group] + (R() - 0.5) * 0.05, ny: ny + (R() - 0.5) * 0.03 });
        }
        return arr;
      };

      // --- Sensory ---
      const sPos = place('sensory', SENSORY.length, [0.12, 0.88]);
      const sensory = SENSORY.map(([name, role], k) =>
        this._addNeuron(name, 'sensory', role, sPos[k].nx, sPos[k].ny, { loomW: role === 'loom' ? 1 : 0 }));

      // --- Local interneurons ---
      const nLocal = LOCAL_CLUSTERS.length * 4;
      const lPos = place('local', nLocal, [0.06, 0.94]);
      const locals = [];
      LOCAL_CLUSTERS.forEach((cluster, ci) => {
        for (let k = 1; k <= 4; k++) {
          const idx = ci * 4 + (k - 1);
          locals.push(this._addNeuron(cluster + k, 'local', 'local', lPos[idx].nx, lPos[idx].ny));
        }
      });

      // --- Descending ---
      const dPos = place('descending', DESC.length, [0.14, 0.86]);
      const desc = DESC.map((name, k) => this._addNeuron(name, 'descending', 'desc', dPos[k].nx, dPos[k].ny));

      // --- Giant fibre ---
      // GF adapts hard: it fires a single decisive command, then goes quiet.
      const gf = GF.map((name, k) => this._addNeuron(name, 'giantfiber', 'gf',
        layers.giantfiber + (R() - 0.5) * 0.03, k === 0 ? 0.36 : 0.64,
        { isGF: true, side: k === 0 ? -1 : 1, adaptGain: 34 }));

      // --- Motor ---
      const mPos = place('motor', MOTOR.length, [0.10, 0.90]);
      const motor = MOTOR.map(([name, role], k) => this._addNeuron(name, 'motor', role, mPos[k].nx, mPos[k].ny,
        { side: name.endsWith('_L') ? -1 : name.endsWith('_R') ? 1 : 0 }));

      // --- Wiring ---
      // Looming detectors feed a monosynaptic escape line (real: LC4 -> GF / DNa).
      sensory.filter(n => n.role === 'loom').forEach(n => {
        gf.forEach(g => this._connect(n, g, 9 + R() * 3, 1.1));
        desc.slice(0, 4).forEach(d => this._connect(n, d, 7 + R() * 4, 1.6));
        for (let k = 0; k < 5; k++) this._connect(n, locals[(R() * locals.length) | 0], 12 + R() * 8, 2.2);
      });
      sensory.filter(n => n.role !== 'loom').forEach(n => {
        for (let k = 0; k < 6; k++) this._connect(n, locals[(R() * locals.length) | 0], 5 + R() * 5, 2.2);
      });

      // Local recurrent + feed-forward spread.
      locals.forEach(l => {
        for (let k = 0; k < 3; k++) this._connect(l, locals[(R() * locals.length) | 0], 2.2 + R() * 3.2, 2.4);
        for (let k = 0; k < 3; k++) this._connect(l, desc[(R() * desc.length) | 0], 4 + R() * 6, 2.6);
      });

      // Descending -> giant fibre (escape command).
      desc.forEach(d => gf.forEach(g => this._connect(d, g, 6 + R() * 5, 1.8)));

      // Giant fibre -> fast motor output. Left GF drives left muscles, right drives right.
      gf.forEach(g => motor.forEach(m => {
        const same = (m.side === g.side) || m.side === 0;
        this._connect(g, m, same ? 58 + R() * 22 : 4 + R() * 4, 1.0);
      }));

      // Wing-steering oscillator: reciprocal inhibition between left/right wing motors.
      const wl = motor[0], wr = motor[1];
      this._connect(wl, wr, -14, 2.0);
      this._connect(wr, wl, -14, 2.0);
      desc.slice(4, 8).forEach(d => { this._connect(d, wl, 5 + R() * 4, 2.2); this._connect(d, wr, 5 + R() * 4, 2.2); });

      // Light tonic drive keeps the CPG breathing.
      this.tonic = desc.slice(4, 8);
    }

    _noise() {
      // Box–Muller, unit variance.
      let u = 0, v = 0;
      while (u === 0) u = this.rand();
      while (v === 0) v = this.rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    /**
     * Advance the network.
     * @param {number} dtMs  elapsed simulated ms (clamped by caller)
     * @param {object} input {loom:0..3, motion:0..1, gain:0..3}
     */
    step(dtMs, input) {
      input = input || {};
      const dt = dtMs;
      const loom = Math.max(0, input.loom || 0);
      const motion = Math.max(0, input.motion || 0);
      const gain = input.gain == null ? 1 : input.gain;

      // Smooth the loom drive for the readout.
      this.sensorDrive += (loom - this.sensorDrive) * Math.min(1, dt / 40);

      const fired = [];
      const N = this.neurons;
      for (let i = 0; i < N.length; i++) {
        const n = N[i];
        let I = this._noise() * 2.0;

        // Habituation acts nonlinearly on the sensory drive, like synaptic
        // depression at the looming->escape relay (a waving hand stops working).
        if (n.role === 'loom') I += loom * 46 * gain * gain * n.loomW;
        else if (n.role === 'motion') I += motion * 26;
        else if (this.tonic.indexOf(n) >= 0) I += 9;

        n.I = n.I * Math.exp(-dt / this.tauSyn) + I;
        n.a *= Math.exp(-dt / this.adaptTau);
        n.v += (-(n.v - this.vrest) - n.a * n.adaptGain + n.I) * (dt / this.tau);
        n.tref -= dt;

        if (n.tref <= 0 && n.v >= this.vth) {
          n.v = this.vreset;
          n.tref = this.trefMs;
          n.a += 7.5;
          n.spikes++;
          n.last = this.time;
          n.rate += 1;
          fired.push(n);
        }
      }

      // Propagate spikes through synapses with axonal delay.
      for (let f = 0; f < fired.length; f++) {
        const n = fired[f];
        if (n.isGF) {
          this.gfSpikes++;
          this.gfEvent = n.side < 0 ? 'L' : 'R';
          n.flash = 1;
        }
        for (let s = 0; s < n.out.length; s++) {
          const sy = n.out[s];
          this.pending.push({ t: this.time + sy.delay, post: sy.post, w: sy.w, s: sy });
        }
      }

      // Deliver due synaptic currents.
      if (this.pending.length) {
        const keep = [];
        for (let k = 0; k < this.pending.length; k++) {
          const e = this.pending[k];
          if (e.t <= this.time) {
            N[e.post].I += e.w;
            e.s.pulse = 1;
          } else keep.push(e);
        }
        this.pending = keep;
      }

      // Roll rates toward zero.
      const decay = Math.exp(-dt / 90);
      for (let i = 0; i < N.length; i++) {
        N[i].rate *= decay;
        if (N[i].flash) N[i].flash *= Math.exp(-dt / 70);
      }

      this.time += dt;

      const motorOut = this._motorOutput();
      return { gf: this.gfEvent, fired, motor: motorOut };
    }

    _motorOutput() {
      // Population readout: left vs right muscle drive, used to steer the fly.
      let left = 0, right = 0, nLeft = 0, nRight = 0;
      for (const n of this.neurons) {
        if (n.group !== 'motor') continue;
        if (n.side < 0) { left += n.rate; nLeft++; }
        else if (n.side > 0) { right += n.rate; nRight++; }
      }
      left = nLeft ? left / nLeft : 0;
      right = nRight ? right / nRight : 0;
      // A slow oscillator on the wing pair gives the idle wander its rhythm.
      return { left, right, turn: right - left };
    }

    consumeGF() {
      const e = this.gfEvent;
      this.gfEvent = null;
      return e;
    }

    /** Reset the adaptation / habituation state between rounds. */
    reset() {
      for (const n of this.neurons) {
        n.v = this.vrest; n.I = 0; n.a = 0; n.tref = 0; n.rate = 0;
        n.spikes = 0; n.flash = 0;
      }
      for (const s of this.synapses) s.pulse = 0;
      this.pending = [];
      this.time = 0;
      this.gfSpikes = 0;
      this.gfEvent = null;
      this.sensorDrive = 0;
    }
  }

  global.FlyNet = FlyNet;
  global.FLY_GROUPS = GROUPS;
  if (typeof module !== 'undefined' && module.exports) module.exports = { FlyNet, GROUPS };
})(typeof window !== 'undefined' ? window : globalThis);
