/* FLY OR DIE — arcade layer.
 * The fly's escape decisions come from the FlyNet simulation in neural.js:
 * a looming-sensitive spike reaches the giant fibre, and that spike is what
 * commits the fly to a dodge. Habituation is synaptic depression applied to
 * the same sensory pathway.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rand = (a, b) => a + Math.random() * (b - a);
  const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
  const TAU = Math.PI * 2;

  const GROUP_COLORS = {
    sensory: '#3ad2ff', local: '#8a6bff', descending: '#ffab2e',
    giantfiber: '#ff2e88', motor: '#8dff6b',
  };

  // ------------------------------------------------------------------ audio
  const Sfx = {
    ctx: null, on: true,
    init() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    },
    blip(freq, dur, type, gain, slide) {
      if (!this.on || !this.ctx) return;
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, slide), t + dur);
      g.gain.setValueAtTime(gain || 0.05, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.ctx.destination);
      o.start(t); o.stop(t + dur + 0.02);
    },
    shot() { this.blip(760, 0.09, 'square', 0.04, 240); },
    gf() { this.blip(1500, 0.16, 'sawtooth', 0.05, 420); },
    hit() { this.blip(180, 0.18, 'square', 0.08, 70); this.blip(340, 0.1, 'triangle', 0.05, 90); },
    miss() { this.blip(300, 0.06, 'triangle', 0.03, 200); },
    win() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.blip(f, 0.16, 'triangle', 0.06), i * 110)); },
    lose() { [330, 262, 196, 147].forEach((f, i) => setTimeout(() => this.blip(f, 0.22, 'sawtooth', 0.05), i * 130)); },
  };

  // ------------------------------------------------------- canvas utilities
  function fitCanvas(canvas) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 150;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  // --------------------------------------------------- background connectome
  const BG = {
    canvas: null, ctx: null, w: 0, h: 0, nodes: [],
    init() {
      this.canvas = $('bgCanvas');
      this.ctx = this.canvas.getContext('2d');
      this.resize();
      addEventListener('resize', () => this.resize());
    },
    resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.w = innerWidth; this.h = innerHeight;
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.min(90, Math.round(this.w * this.h / 22000));
      this.nodes = Array.from({ length: n }, () => ({
        x: rand(0, this.w), y: rand(0, this.h),
        vx: rand(-6, 6), vy: rand(-6, 6), r: rand(0.6, 1.8),
      }));
    },
    draw(dt) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      const ns = this.nodes;
      for (const n of ns) {
        n.x += n.vx * dt; n.y += n.vy * dt;
        if (n.x < 0 || n.x > this.w) n.vx *= -1;
        if (n.y < 0 || n.y > this.h) n.vy *= -1;
      }
      ctx.lineWidth = 0.5;
      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          const d = dist(ns[i].x, ns[i].y, ns[j].x, ns[j].y);
          if (d < 130) {
            ctx.strokeStyle = 'rgba(90,140,255,' + (0.05 * (1 - d / 130)).toFixed(3) + ')';
            ctx.beginPath(); ctx.moveTo(ns[i].x, ns[i].y); ctx.lineTo(ns[j].x, ns[j].y); ctx.stroke();
          }
        }
      }
      for (const n of ns) {
        ctx.fillStyle = 'rgba(120,180,255,0.5)';
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, TAU); ctx.fill();
      }
    },
  };

  // ------------------------------------------------------------------- game
  const game = {
    phase: 'idle',
    net: null,
    W: 0, H: 0,
    shots: 10, hits: 0, hp: 3,
    darts: [], particles: [], rings: [],
    fly: null,
    aim: { x: 0, y: 0 },
    hab: 1,
    t0: 0, elapsed: 0,
    gfCount: 0, maxLoom: 0, longestDodge: 0,
    status: '', statusT: 0,
    muzzle: 0, shakeT: 0,
    frameDt: 16,
  };

  const arena = $('arenaCanvas');
  const netCanvas = $('netCanvas');
  const rasterCanvas = $('rasterCanvas');
  let actx = null, netctx = null, rctx = null;

  const FLY_R = 16;
  const DART_R = 4;
  const LOOM_K = 1.3;

  function resetRound() {
    game.net = new window.FlyNet((Math.random() * 1e9) | 0);
    game.shots = 10; game.hits = 0; game.hp = 3;
    game.darts = []; game.particles = []; game.rings = [];
    game.hab = 1; game.elapsed = 0; game.t0 = performance.now();
    game.gfCount = 0; game.maxLoom = 0; game.longestDodge = 0;
    game.muzzle = 0; game.shakeT = 0;
    spikeLog.length = 0;
    const f = {
      x: game.W * 0.5, y: game.H * 0.35, ang: 0, vx: 0, vy: 0,
      wing: 0, speed: 150, escapeUntil: 0, escapeCooldown: 0,
      escapeDir: 0, escapeSpeed: 0, pending: null, invulnUntil: 0, hitFlash: 0,
      windedUntil: 0, dodgeStart: 0,
    };
    game.fly = f;
    game.aim.x = game.W * 0.5; game.aim.y = game.H * 0.22;
    updatePips();
    $('neuronCount').textContent = game.net.neurons.length;
    $('synapseCount').textContent = game.net.synapses.length;
    setStatus('ROUND LIVE — 10 DARTS', 1500);
  }

  function startGame() {
    Sfx.init();
    if (Sfx.ctx && Sfx.ctx.state === 'suspended') Sfx.ctx.resume();
    game.phase = 'playing';
    $('startOverlay').classList.remove('show');
    $('endOverlay').classList.remove('show');
    resetRound();
  }

  function updatePips() {
    const sp = $('shotsPips'), hp = $('hpPips');
    sp.innerHTML = ''; hp.innerHTML = '';
    for (let i = 0; i < 10; i++) {
      const d = document.createElement('span');
      d.className = 'pip' + (i < game.shots ? '' : ' spent');
      sp.appendChild(d);
    }
    for (let i = 0; i < 3; i++) {
      const d = document.createElement('span');
      d.className = 'pip' + (i < game.hp ? '' : ' spent');
      hp.appendChild(d);
    }
  }

  function setStatus(s, ms) { game.status = s; game.statusT = performance.now() + (ms || 1400); }
  function addParticles(x, y, color, n, spd) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, v = rand(0.3, 1) * (spd || 240);
      game.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.3, 0.8), max: 0.8, color, size: rand(1, 2.6) });
    }
  }

  // --------------------------------------------------------------- firing
  function fire() {
    if (game.phase !== 'playing' || game.shots <= 0) return;
    const W = game.W, H = game.H;
    const mx = W / 2, my = H - 40;
    const ax = clamp(game.aim.x, 8, W - 8), ay = clamp(game.aim.y, 8, H - 8);
    const dx = ax - mx, dy = ay - my;
    const len = Math.hypot(dx, dy) || 1;
    const speed = 1500;
    game.darts.push({ x: mx, y: my, vx: dx / len * speed, vy: dy / len * speed, px: mx, py: my, minD: Infinity, prevD: Infinity, whiffed: false, trail: [] });
    game.shots--;
    game.muzzle = 1;
    game.hab = clamp(game.hab * 0.87, 0.12, 1.7);
    addParticles(mx, my, '#ffd35a', 6, 160);
    Sfx.shot();
    updatePips();
    setStatus(game.shots + ' DARTS LEFT', 700);
  }

  // ------------------------------------------------------- escape decision
  function threatLooms() {
    const f = game.fly;
    let best = 0, dart = null;
    for (const d of game.darts) {
      const rx = f.x - d.x, ry = f.y - d.y;
      const dd = Math.max(22, Math.hypot(rx, ry));
      const ux = rx / dd, uy = ry / dd;
      const relvx = f.vx - d.vx, relvy = f.vy - d.vy;
      const closing = -(relvx * ux + relvy * uy);
      const loom = clamp(FLY_R * Math.max(0, closing) / (dd * dd) * LOOM_K, 0, 3);
      if (loom > best) { best = loom; dart = d; }
    }
    return { loom: best, dart };
  }

  function chooseDodge(dart, side) {
    const f = game.fly;
    const vlen = Math.hypot(dart.vx, dart.vy) || 1;
    const ux = dart.vx / vlen, uy = dart.vy / vlen;
    let px = -uy, py = ux;
    const rx = f.x - dart.x, ry = f.y - dart.y;
    if (px * rx + py * ry < 0) { px = -px; py = -py; }
    if (Math.random() < 0.15) { px = -px; py = -py; }
    // steer away from walls
    const m = 42;
    if (f.x < m && px < 0) px = Math.abs(px);
    if (f.x > game.W - m && px > 0) px = -Math.abs(px);
    if (f.y < m && py < 0) py = Math.abs(py);
    if (f.y > game.H - m && py > 0) py = -Math.abs(py);
    const err = rand(-0.28, 0.28);
    const ca = Math.cos(err), sa = Math.sin(err);
    return Math.atan2(px * sa + py * ca, px * ca - py * sa);
  }

  function scheduleEscape(side) {
    const f = game.fly;
    const now = performance.now();
    if (f.pending || now < f.escapeCooldown || game.phase !== 'playing') return;
    if (now < f.invulnUntil) return;
    const th = threatLooms();
    if (!th.dart || th.loom < 0.05) return;
    game.gfCount++;
    const hb = clamp(game.hab, 0.12, 1.7);
    const reaction = rand(30, 90) * clamp(1 / hb, 0.6, 4);
    f.pending = { at: now + reaction, side, dart: th.dart };
    Sfx.gf();
    game.rings.push({ x: f.x, y: f.y, r: 6, max: 70, life: 1, color: '255,46,136' });
    setStatus('◉ GIANT FIBRE FIRED — ESCAPE', 900);
    $('gfState').textContent = 'FIRED';
    $('gfState').className = 'gf-fire';
    clearTimeout(game._gfr);
    game._gfr = setTimeout(() => { const g = $('gfState'); g.textContent = 'ARMED'; g.className = 'gf-idle'; }, 220);
  }

  function executeEscape() {
    const f = game.fly;
    const p = f.pending; f.pending = null;
    if (!p || game.phase !== 'playing') return;
    const now = performance.now();
    if (now < f.invulnUntil) return;
    f.escapeDir = chooseDodge(p.dart, p.side);
    const hab = clamp(game.hab, 0.12, 1.7);
    f.escapeSpeed = Math.min(1120, 350 + 720 * Math.min(1, hab));
    const dur = Math.min(260, 110 + 130 * hab);
    f.escapeUntil = now + dur;
    f.escapeCooldown = now + dur + 420;
    f.windedUntil = now + dur + 320;
    f.dodgeStart = now;
    game.rings.push({ x: f.x, y: f.y, r: 4, max: 90, life: 1, color: '255,46,136' });
  }

  // --------------------------------------------------------- fly behaviour
  function wanderAngle(t) {
    return 2.1 * Math.sin(t * 0.00042) + 1.25 * Math.sin(t * 0.0011 + 2.1) + 0.7 * Math.sin(t * 0.0027 + 4.2);
  }

  function updateFly(dtS, motor) {
    const f = game.fly, now = performance.now();
    if (f.pending && now >= f.pending.at) executeEscape();

    const escaping = now < f.escapeUntil;
    const winded = now < f.windedUntil;
    if (escaping) {
      const prog = 1 - (f.escapeUntil - now) / Math.max(1, f.escapeUntil - f.dodgeStart);
      f.speed = f.escapeSpeed * (1 - 0.55 * prog);
      f.ang += angleDelta(f.ang, f.escapeDir) * Math.min(1, dtS * 26);
    } else {
      const t = now;
      let target = wanderAngle(t);
      // motor readout from the simulation nudges the heading — the fly literally
      // flies where its motor neurons tell it to.
      target += clamp(motor.turn * 260, -1.1, 1.1) * 0.5;
      const baseSpeed = (winded ? 26 : 120) + (winded ? 10 : 38) * Math.sin(t * 0.0016 + 1) + (winded ? 6 : 22) * Math.sin(t * 0.004);
      f.speed += (baseSpeed * (winded ? 0.5 : 1) - f.speed) * Math.min(1, dtS * (winded ? 12 : 2.2));
      f.ang += angleDelta(f.ang, target) * Math.min(1, dtS * 3.2);
    }

    const prevX = f.x, prevY = f.y;
    f.x += Math.cos(f.ang) * f.speed * dtS;
    f.y += Math.sin(f.ang) * f.speed * dtS;

    const m = 16;
    if (f.x < m) { f.x = m; if (Math.cos(f.ang) < 0) f.ang = Math.PI - f.ang + rand(-0.3, 0.3); }
    if (f.x > game.W - m) { f.x = game.W - m; if (Math.cos(f.ang) > 0) f.ang = Math.PI - f.ang + rand(-0.3, 0.3); }
    if (f.y < m) { f.y = m; if (Math.sin(f.ang) < 0) f.ang = -f.ang + rand(-0.3, 0.3); }
    if (f.y > game.H - m) { f.y = game.H - m; if (Math.sin(f.ang) > 0) f.ang = -f.ang + rand(-0.3, 0.3); }

    f.vx = (f.x - prevX) / Math.max(1e-4, dtS);
    f.vy = (f.y - prevY) / Math.max(1e-4, dtS);
    f.wing += (f.speed * 0.06 + 6) * dtS * TAU * 0.16;
    f.hitFlash *= Math.exp(-dtS / 0.12);
    if (escaping) game.longestDodge = Math.max(game.longestDodge, now - f.dodgeStart);
  }

  function angleDelta(a, b) {
    let d = (b - a) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return d;
  }

  // --------------------------------------------------------- darts & hits
  function updateDarts(dtS) {
    const f = game.fly, now = performance.now();
    for (let i = game.darts.length - 1; i >= 0; i--) {
      const d = game.darts[i];
      d.px = d.x; d.py = d.y;
      d.x += d.vx * dtS; d.y += d.vy * dtS;
      d.trail.push({ x: d.x, y: d.y });
      if (d.trail.length > 8) d.trail.shift();

      const dd = dist(d.x, d.y, f.x, f.y);
      d.prevD = d.minD;
      d.minD = Math.min(d.minD, dd);

      if (dd < FLY_R + DART_R && now > f.invulnUntil) {
        // HIT
        game.hp--; game.hits++; game.darts.splice(i, 1);
        f.invulnUntil = now + 900;
        f.hitFlash = 1;
        f.escapeUntil = 0; f.pending = null; f.escapeCooldown = now + 240; f.windedUntil = now + 700;
        game.hab = clamp(game.hab * 1.80, 0.12, 1.7);
        const kb = 240 / (Math.hypot(d.vx, d.vy) || 1);
        f.x = clamp(f.x + d.vx * kb * 0.4, 20, game.W - 20);
        f.y = clamp(f.y + d.vy * kb * 0.4, 20, game.H - 20);
        addParticles(f.x, f.y, '#ff2e88', 22, 340);
        addParticles(f.x, f.y, '#ffd35a', 12, 260);
        game.rings.push({ x: f.x, y: f.y, r: 6, max: 110, life: 1, color: '255,211,90' });
        game.shakeT = 0.28;
        Sfx.hit();
        updatePips();
        setStatus(game.hp > 0 ? 'DIRECT HIT!  HP ' + game.hp + '/3' : 'FLY DOWN', 1100);
        if (game.hp <= 0) { win(); return; }
        continue;
      }

      // near miss → sensitise
      if (!d.whiffed && d.minD < 40 && d.minD > FLY_R + DART_R && dd > d.prevD) {
        d.whiffed = true;
        game.hab = clamp(game.hab * 1.30, 0.12, 1.7);
        setStatus('WHIFF — FLY SENSITISED', 800);
      }

      if (d.x < -30 || d.x > game.W + 30 || d.y < -30 || d.y > game.H + 30 || d.trail.length > 60) {
        game.darts.splice(i, 1);
      }
    }
    if (game.phase === 'playing' && game.shots === 0 && game.darts.length === 0 && game.hp > 0) lose();
  }

  // --------------------------------------------------------------- outcome
  function statsHtml(shotsUsed, timeS) {
    return (
      '<div>SHOTS USED<b>' + shotsUsed + ' / 10</b></div>' +
      '<div>HITS<b>' + game.hits + ' / 3</b></div>' +
      '<div>GIANT-FIBRE FIRINGS<b>' + game.gfCount + '</b></div>' +
      '<div>PEAK LOOM<b>' + game.maxLoom.toFixed(2) + '</b></div>' +
      '<div>LONGEST DODGE<b>' + (game.longestDodge / 1000).toFixed(2) + ' s</b></div>' +
      '<div>TIME<b>' + timeS.toFixed(1) + ' s</b></div>'
    );
  }

  function showResult(win_) {
    const timeS = game.elapsed / 1000;
    const used = 10 - game.shots;
    let grade, title, sub;
    if (win_) {
      grade = used <= 4 ? 'S' : used <= 6 ? 'A' : used <= 8 ? 'B' : 'C';
      title = 'YOU WIN';
      sub = used <= 4
        ? 'S-rank. You out-thought a fly. That is the whole flex.'
        : 'The fly has been debugged. Barely.';
      Sfx.win();
    } else {
      grade = 'F';
      title = 'THE FLY WINS';
      sub = game.hits > 0 ? 'You drew blood. The fly is still flying.' : 'The fly did not get hit once. Rude.';
      Sfx.lose();
    }
    $('endGrade').textContent = grade;
    $('endTitle').textContent = title;
    $('endSub').textContent = sub;
    $('endStats').innerHTML = statsHtml(used, timeS);
    $('copyMsg').textContent = '';
    $('endOverlay').classList.add('show');
    $('endOverlay').dataset.win = win_ ? '1' : '0';
    $('endOverlay').dataset.used = used;
    $('endOverlay').dataset.hits = game.hits;
  }

  function win() { game.phase = 'over'; showResult(true); }
  function lose() { game.phase = 'over'; showResult(false); }

  // ------------------------------------------------------------ main loop
  let last = performance.now();
  let spikeLog = [];

  function loop(nowT) {
    requestAnimationFrame(loop);
    let frameDt = Math.min(50, nowT - last);
    last = nowT;
    if (!actx) return;
    const dtS = frameDt / 1000;

    BG.draw(frameDt / 1000);

    // ---- simulation ----
    const th = threatLooms();
    game.maxLoom = Math.max(game.maxLoom, th.loom);
    if (game.phase === 'playing') game.elapsed = nowT - game.t0;
    const gain = clamp(game.hab, 0.12, 1.7);
    let gf = null;
    let steps = Math.max(1, Math.round(frameDt));
    let motor = { left: 0, right: 0, turn: 0 };
    for (let i = 0; i < steps; i++) {
      const r = game.net.step(1, { loom: th.loom, gain });
      motor = r.motor;
      if (r.gf) gf = r.gf;
      game.net.consumeGF();
      for (let k = 0; k < r.fired.length; k++) {
        spikeLog.push({ i: r.fired[k].i, t: game.net.time });
      }
    }
    // habituation recovers while you are not shooting
    game.hab += (1 - game.hab) * Math.min(1, frameDt / 1200);
    game.hab = clamp(game.hab, 0.12, 1.7);

    if (gf && game.phase === 'playing') scheduleEscape(gf);

    // ---- world ----
    // the fly keeps flying after the round ends, for ambience
    updateFly(dtS, motor);
    updateDarts(dtS);

    // trim spike log
    const cutoff = game.net.time - 2200;
    while (spikeLog.length && spikeLog[0].t < cutoff) spikeLog.shift();

    // ---- render ----
    drawArena(nowT, frameDt);
    drawNet();
    drawRaster(nowT);
    updateReadouts();

    // timer
    if (game.phase === 'playing') $('timer').textContent = (game.elapsed / 1000).toFixed(1) + 's';
  }

  // ---------------------------------------------------------------- render
  function drawArena(nowT, frameDt) {
    const ctx = actx, W = game.W, H = game.H;
    const dtS = frameDt / 1000;
    ctx.save();
    if (game.shakeT > 0) {
      game.shakeT = Math.max(0, game.shakeT - dtS);
      ctx.translate(rand(-5, 5) * game.shakeT, rand(-5, 5) * game.shakeT);
    }
    ctx.clearRect(-20, -20, W + 40, H + 40);

    // field
    const g = ctx.createRadialGradient(W / 2, H * 0.5, 40, W / 2, H * 0.5, Math.max(W, H) * 0.75);
    g.addColorStop(0, '#0b1024'); g.addColorStop(1, '#03040a');
    ctx.fillStyle = g; ctx.fillRect(-20, -20, W + 40, H + 40);

    // grid
    ctx.strokeStyle = 'rgba(90,140,255,0.07)'; ctx.lineWidth = 1;
    const gs = 44;
    for (let x = 0; x < W; x += gs) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += gs) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    // threat vector line (aim)
    const mx = W / 2, my = H - 40;
    ctx.strokeStyle = 'rgba(255,171,46,0.16)';
    ctx.setLineDash([4, 8]); ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(game.aim.x, game.aim.y); ctx.stroke(); ctx.setLineDash([]);

    // darts
    for (const d of game.darts) {
      const tx = d.x - d.vx * 0.028, ty = d.y - d.vy * 0.028;
      const lg = ctx.createLinearGradient(tx, ty, d.x, d.y);
      lg.addColorStop(0, 'rgba(255,211,90,0)'); lg.addColorStop(1, 'rgba(255,211,90,0.95)');
      ctx.strokeStyle = lg; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(d.x, d.y); ctx.stroke();
      ctx.fillStyle = '#fff6d6'; ctx.shadowColor = '#ffd35a'; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(d.x, d.y, DART_R, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
    }

    // rings
    for (let i = game.rings.length - 1; i >= 0; i--) {
      const r = game.rings[i];
      r.r += (r.max - r.r) * Math.min(1, dtS * 7);
      r.life -= dtS * 1.7;
      if (r.life <= 0) { game.rings.splice(i, 1); continue; }
      ctx.strokeStyle = 'rgba(' + r.color + ',' + (r.life * 0.8).toFixed(2) + ')';
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, TAU); ctx.stroke();
    }

    drawFly(ctx, nowT);

    // particles
    for (let i = game.particles.length - 1; i >= 0; i--) {
      const p = game.particles[i];
      p.life -= dtS; if (p.life <= 0) { game.particles.splice(i, 1); continue; }
      p.x += p.vx * dtS; p.y += p.vy * dtS; p.vx *= 0.96; p.vy *= 0.96;
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // turret
    const ang = Math.atan2(game.aim.y - my, game.aim.x - mx);
    ctx.save(); ctx.translate(mx, my); ctx.rotate(ang);
    ctx.fillStyle = '#1a2036'; ctx.strokeStyle = '#3ad2ff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, 10, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#3ad2ff'; ctx.fillRect(4, -3.2, 20, 6.4);
    if (game.muzzle > 0) {
      ctx.globalAlpha = game.muzzle;
      ctx.fillStyle = '#ffd35a'; ctx.shadowColor = '#ffd35a'; ctx.shadowBlur = 20;
      ctx.beginPath(); ctx.arc(24, 0, 8 * game.muzzle, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    game.muzzle = Math.max(0, game.muzzle - dtS * 8);

    // reticle
    const ax = clamp(game.aim.x, 8, W - 8), ay = clamp(game.aim.y, 8, H - 8);
    ctx.strokeStyle = game.shots > 0 ? 'rgba(255,171,46,0.9)' : 'rgba(255,77,94,0.9)';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(ax, ay, 13, 0, TAU); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ax - 20, ay); ctx.lineTo(ax - 8, ay); ctx.moveTo(ax + 8, ay); ctx.lineTo(ax + 20, ay);
    ctx.moveTo(ax, ay - 20); ctx.lineTo(ax, ay - 8); ctx.moveTo(ax, ay + 8); ctx.lineTo(ax, ay + 20);
    ctx.stroke();
    ctx.restore();

    // status line + timers
    const f = game.fly;
    const windedNow = f && nowT < f.windedUntil && nowT > f.escapeUntil;
    const line = $('statusLine');
    if (nowT < game.statusT) { line.textContent = game.status; line.classList.add('hot'); }
    else if (game.phase === 'playing' && windedNow) { line.textContent = 'WINDED — HIT IT NOW'; line.classList.add('hot'); }
    else { line.textContent = game.phase === 'playing' ? 'TRACKING…' : (game.phase === 'over' ? 'ROUND OVER' : 'AWAITING CHALLENGER'); line.classList.remove('hot'); }
  }

  function drawFly(ctx, nowT) {
    const f = game.fly;
    if (!f) return;
    const escaping = nowT < f.escapeUntil;
    const invuln = nowT < f.invulnUntil;
    ctx.save();
    ctx.translate(f.x, f.y);
    if (invuln && Math.floor(nowT / 70) % 2 === 0) ctx.globalAlpha = 0.45;

    // escape speed lines
    if (escaping) {
      ctx.strokeStyle = 'rgba(255,46,136,0.55)'; ctx.lineWidth = 2;
      for (let k = 0; k < 3; k++) {
        const o = (k - 1) * 7;
        ctx.beginPath();
        ctx.moveTo(-Math.cos(f.ang) * 16 + Math.cos(f.ang + Math.PI / 2) * o, -Math.sin(f.ang) * 16 + Math.sin(f.ang + Math.PI / 2) * o);
        ctx.lineTo(-Math.cos(f.ang) * 40 + Math.cos(f.ang + Math.PI / 2) * o, -Math.sin(f.ang) * 40 + Math.sin(f.ang + Math.PI / 2) * o);
        ctx.stroke();
      }
    }

    ctx.rotate(f.ang);
    const flap = Math.sin(f.wing) * 0.9;
    // wings
    ctx.globalAlpha *= 0.55;
    ctx.fillStyle = 'rgba(58,210,255,0.5)';
    for (const s of [-1, 1]) {
      ctx.save(); ctx.translate(-1, s * 4); ctx.rotate(s * (0.5 + flap * 0.55));
      ctx.beginPath(); ctx.ellipse(-7, 0, 12, 4.4, 0, 0, TAU); ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = invuln && Math.floor(nowT / 70) % 2 === 0 ? 0.45 : 1;

    // body
    ctx.shadowColor = f.hitFlash > 0.1 ? '#ffd35a' : '#ff2e88';
    ctx.shadowBlur = 14 + f.hitFlash * 24;
    ctx.fillStyle = '#2a2f52';
    ctx.strokeStyle = f.hitFlash > 0.1 ? '#ffd35a' : '#ff2e88';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, 0, FLY_R, 7.2, 0, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;
    // abdomen stripes
    ctx.strokeStyle = 'rgba(255,46,136,0.6)'; ctx.lineWidth = 1;
    for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.moveTo(k * 4, -6); ctx.lineTo(k * 4, 6); ctx.stroke(); }
    // head + eyes
    ctx.fillStyle = '#3a3f66'; ctx.beginPath(); ctx.arc(FLY_R - 1, 0, 4.6, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ff2e88'; ctx.beginPath(); ctx.arc(FLY_R + 1.4, -2.4, 2.1, 0, TAU); ctx.arc(FLY_R + 1.4, 2.4, 2.1, 0, TAU); ctx.fill();
    // legs
    ctx.strokeStyle = 'rgba(180,200,255,0.5)'; ctx.lineWidth = 1;
    for (const s of [-1, 1]) for (let k = -1; k <= 1; k++) {
      ctx.beginPath(); ctx.moveTo(k * 4, s * 6); ctx.lineTo(k * 4 - 3, s * 11); ctx.stroke();
    }
    ctx.restore();

    const winded = nowT < f.windedUntil && nowT > f.escapeUntil;
    if (winded) {
      const pulse = 0.5 + 0.5 * Math.sin(nowT / 130);
      ctx.strokeStyle = 'rgba(255,171,46,' + (0.3 + 0.45 * pulse).toFixed(2) + ')';
      ctx.setLineDash([3, 6]); ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(f.x, f.y, FLY_R + 10, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,171,46,' + (0.55 + 0.45 * pulse).toFixed(2) + ')';
      ctx.font = '600 10px "JetBrains Mono", monospace';
      ctx.fillText('WINDED', f.x - 25, f.y - FLY_R - 16);
    }

    if (f.pending) {
      ctx.fillStyle = '#ff2e88'; ctx.font = '600 13px "JetBrains Mono", monospace';
      ctx.fillText('!', f.x + 16, f.y - 16);
    }
  }

  function drawNet() {
    const ctx = netctx, W = game.net ? netCanvas.clientWidth : 0, H = netCanvas.clientHeight;
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const net = game.net;
    const pad = 12;
    const X = (n) => pad + n.nx * (W - pad * 2);
    const Y = (n) => pad + n.ny * (H - pad * 2);

    // synapses
    ctx.lineWidth = 0.7;
    for (const s of net.synapses) {
      const a = net.neurons[s.pre], b = net.neurons[s.post];
      const pulse = s.pulse || 0;
      ctx.strokeStyle = 'rgba(120,150,230,' + (0.03 + pulse * 0.5).toFixed(3) + ')';
      ctx.beginPath(); ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(b), Y(b)); ctx.stroke();
      s.pulse *= 0.9;
    }
    // nodes
    for (const n of net.neurons) {
      const c = GROUP_COLORS[n.group] || '#fff';
      const rr = 2 + Math.min(6, n.rate * 1.6) + (n.flash || 0) * 5;
      if (n.flash > 0.05) {
        ctx.shadowColor = c; ctx.shadowBlur = 14;
      }
      ctx.fillStyle = c;
      ctx.globalAlpha = 0.45 + Math.min(0.55, n.rate * 0.9) + (n.flash || 0) * 0.5;
      ctx.beginPath(); ctx.arc(X(n), Y(n), rr, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    }
    // GF labels
    ctx.font = '9px "JetBrains Mono", monospace';
    for (const n of net.neurons) {
      if (n.isGF) {
        ctx.fillStyle = '#ff2e88';
        ctx.fillText(n.name, X(n) - 24, Y(n) + 3);
      }
    }
  }

  function drawRaster(nowT) {
    const ctx = rctx, W = rasterCanvas.clientWidth, H = rasterCanvas.clientHeight;
    if (!ctx) return;
    ctx.fillStyle = '#03040a'; ctx.fillRect(0, 0, W, H);
    const net = game.net;
    const N = net.neurons.length;
    const win = 2200, nowSim = net.time;
    const rowH = H / N;
    // group bands + labels
    for (let i = 0; i < N; i++) {
      const n = net.neurons[i];
      const c = GROUP_COLORS[n.group];
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = c;
      ctx.fillRect(0, i * rowH, W, Math.max(1, rowH - 0.5));
      ctx.globalAlpha = 1;
    }
    // spikes
    for (const s of spikeLog) {
      const n = net.neurons[s.i];
      const x = W - ((nowSim - s.t) / win) * W;
      if (x < 0) continue;
      ctx.fillStyle = GROUP_COLORS[n.group];
      ctx.globalAlpha = 0.95;
      ctx.fillRect(x, s.i * rowH, 1.6, Math.max(1, rowH - 0.4));
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H - 0.5); ctx.lineTo(W, H - 0.5); ctx.stroke();
  }

  function updateReadouts() {
    $('loomVal').textContent = game.maxLoom.toFixed(2);
    const m = game.net._motorOutput();
    $('motorVal').textContent = m.left.toFixed(2) + ' / ' + m.right.toFixed(2);
    const habPct = Math.round(clamp((1 - clamp(game.hab, 0.12, 1.7)) / (1 - 0.12), 0, 1) * 100);
    $('habPct').textContent = habPct + '%';
    $('habFill').style.width = habPct + '%';
    const ss = $('simState');
    if (game.phase === 'playing') { ss.textContent = '● SIM'; ss.classList.remove('paused'); }
    else { ss.textContent = '● LIVE PREVIEW'; ss.classList.add('paused'); }
  }

  // ------------------------------------------------------------- interface
  function pointer(e) {
    const r = arena.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    game.aim.x = clamp(p.clientX - r.left, 6, game.W - 6);
    game.aim.y = clamp(p.clientY - r.top, 6, game.H - 6);
  }
  arena.addEventListener('mousemove', pointer);
  arena.addEventListener('touchmove', (e) => { pointer(e); e.preventDefault(); }, { passive: false });
  arena.addEventListener('touchstart', (e) => { pointer(e); }, { passive: true });
  arena.addEventListener('mousedown', (e) => { pointer(e); fire(); });
  arena.addEventListener('touchend', (e) => { fire(); e.preventDefault(); }, { passive: false });
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); fire(); }
    if (e.key === 'r' || e.key === 'R') startGame();
    if (e.key === 'm' || e.key === 'M') toggleSound();
  });

  $('btnStart').addEventListener('click', startGame);
  $('heroPlay').addEventListener('click', () => setTimeout(startGame, 350));
  $('btnRetry').addEventListener('click', startGame);

  function tweetText() {
    const win_ = $('endOverlay').dataset.win === '1';
    const used = $('endOverlay').dataset.used;
    const hits = $('endOverlay').dataset.hits;
    if (win_) return 'I beat FLY OR DIE 🪰 — ' + hits + ' hits with ' + used + ' darts against a simulated fruit-fly escape circuit.\n\nThe fly has 166,000 neurons. I had 10 bullets. Your turn:';
    return 'FLY OR DIE 🪰 — I landed ' + hits + '/10 on a fruit fly running a simulated connectome escape reflex.\n\nThe fly is undefeated. Can you do better?';
  }
  $('btnShareX').addEventListener('click', () => {
    const url = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(tweetText()) + '&url=' + encodeURIComponent(location.href);
    window.open(url, '_blank', 'noopener');
  });
  $('btnCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); $('copyMsg').textContent = 'Link copied.'; }
    catch (e) { $('copyMsg').textContent = location.href; }
  });

  function toggleSound() {
    Sfx.on = !Sfx.on;
    const b = $('soundToggle');
    b.classList.toggle('muted', !Sfx.on);
    b.textContent = Sfx.on ? '♪' : '✕';
  }
  $('soundToggle').addEventListener('click', toggleSound);

  // ---------------------------------------------------------------- boot
  function boot() {
    BG.init();
    const a = fitCanvas(arena); actx = a.ctx; game.W = a.w; game.H = a.h;
    const n = fitCanvas(netCanvas); netctx = n.ctx;
    const r = fitCanvas(rasterCanvas); rctx = r.ctx;
    game.net = new window.FlyNet((Math.random() * 1e9) | 0);
    $('neuronCount').textContent = game.net.neurons.length;
    $('synapseCount').textContent = game.net.synapses.length;
    game.fly = { x: a.w / 2, y: a.h * 0.35, ang: 0, vx: 0, vy: 0, wing: 0, speed: 150, escapeUntil: 0, escapeCooldown: 0, escapeDir: 0, escapeSpeed: 0, pending: null, invulnUntil: 0, hitFlash: 0, windedUntil: 0, dodgeStart: 0 };
    game.aim.x = a.w / 2; game.aim.y = a.h * 0.25;
    addEventListener('resize', () => {
      const a2 = fitCanvas(arena); actx = a2.ctx; game.W = a2.w; game.H = a2.h;
      const n2 = fitCanvas(netCanvas); netctx = n2.ctx;
      const r2 = fitCanvas(rasterCanvas); rctx = r2.ctx;
    });
    requestAnimationFrame(loop);
    if (/(\?|&)debug/.test(location.search)) {
      window.__flyGame = game;
      window.__flyStart = startGame;
      window.__flyFire = fire;
      window.__flyWin = win;
      window.__flyLose = lose;
    }
  }
  boot();
})();
