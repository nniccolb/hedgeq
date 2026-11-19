(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  const h = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const SLOW_MS = 1000;       // a page load over this is "slow"
  const ms = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + ' s' : Math.round(v) + ' ms');
  const secs = (v) => (v / 1000).toFixed(2) + ' s';

  const ROWS = [
    { id: 'adaptive', name: 'Adaptive delay (hedgeq)' },
    { id: 'fixed_capped', name: 'Fixed delay' },
    { id: 'none', name: 'No hedging' },
  ];

  const SURGE = 60;           // % traffic increase at the midpoint (fixed experiment)
  const BUDGET = 10;          // % extra requests allowed
  // Backend scale for the demo: ~30 ms calls, 20 shards (4 cards + 6 bars + 10 rows), 3 minutes of traffic.
  // Servers stall 3% of the time at 40x slower: a deliberately severe setting so the effect is easy to see.
  const SCALE = { fanout: 20, service_median_ms: 30, episode_ms: 700, duration_s: 180, warmup_s: 15, slow_fraction: 0.03, slow_factor: 40 };
  const PIECES = 20;
  let seed = 1;
  let last = null;
  const by = (id) => last.results.find((r) => r.id === id);

  // ------------------------------------------------------------------ data
  async function load() {
    $('#again').disabled = true;
    try {
      const res = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...SCALE, seed, surge_factor: 1 + SURGE / 100, budget: BUDGET / 100 }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'request failed');
      last = body;
      last.ui = { surge: SURGE, budget: BUDGET };
      renderText();
      drawScatter();
      demo.reset();
    } catch (e) {
      $('#result').textContent = 'Error: ' + e.message;
    } finally {
      $('#again').disabled = false;
    }
  }

  function renderText() {
    const { surge, budget } = last.ui;
    $('#seed').textContent = seed;
    $('#exp-budget').textContent = budget;
    $('#exp-shift').textContent = surge > 0
      ? `Halfway through the run, request volume increases by ${surge}%.`
      : 'Request volume stays constant throughout the run.';

    const best = Math.min(...ROWS.map((r) => by(r.id).user.p99));
    $('#tbl tbody').replaceChildren(...ROWS.map((r) => {
      const x = by(r.id);
      const tr = h('tr');
      const cells = [r.name, ms(x.user.p50), ms(x.user.p99), r.id === 'none' ? '0%' : x.extra_pct.toFixed(1) + '%'].map((t) => h('td', '', t));
      if (x.user.p99 === best) cells[2].className = 'best';
      tr.append(...cells);
      return tr;
    }));

    const a = by('adaptive'), f = by('fixed_capped'), n = by('none');
    const ratio = f.user.p99 / a.user.p99;
    const lead = ratio >= 1.1
      ? `With the same ${budget}% budget, the adaptive delay cuts the slowest 1% of page loads to ${ms(a.user.p99)}, ${ratio.toFixed(1)} times lower than the fixed delay (${ms(f.user.p99)}) and ${(n.user.p99 / a.user.p99).toFixed(1)} times lower than no hedging (${ms(n.user.p99)}).`
      : `Under these conditions the adaptive delay (${ms(a.user.p99)}) and the fixed delay (${ms(f.user.p99)}) are within 10% of each other.`;
    $('#result').textContent = `${lead} The typical page load falls from ${ms(n.user.p50)} to ${ms(a.user.p50)}. Adaptive hedging sent ${a.extra_pct.toFixed(1)}% extra requests, within its limit.`;

    const over = (id) => by(id).samples.filter((x) => x[1] > SLOW_MS).length / by(id).samples.length;
    const pct = (v) => Math.round(v * 100) + '%';
    $('#headline').replaceChildren(
      document.createTextNode('The median shard query takes '), h('b', '', ms(n.sub.p50)),
      document.createTextNode(', yet a typical page takes '), h('span', 'bad', ms(n.user.p50)),
      document.createTextNode(', because a page waits for its slowest shard. Hedging brings the typical page to '), h('span', 'good', ms(a.user.p50)),
      document.createTextNode(' and the share of pages over a second from '), h('span', 'bad', pct(over('none'))),
      document.createTextNode(' to '), h('span', 'good', pct(over('adaptive'))), document.createTextNode('.'),
    );
  }

  // ------------------------------------------------- Figure 1: dashboard demo
  // The page is an aggregate over ALL shards: every column height and every total is a sum of 20 partial
  // results, so nothing can be drawn until the slowest shard has answered. (Synthetic events; only the timing is real.)
  const CITIES = [
    ['New York', -74, 40.7, 10], ['Los Angeles', -118, 34, 6], ['Chicago', -87.6, 41.9, 4], ['Mexico City', -99, 19.4, 4],
    ['São Paulo', -46.6, -23.5, 6], ['Buenos Aires', -58, -34.6, 3], ['London', -0.1, 51.5, 8], ['Paris', 2.3, 48.9, 5],
    ['Berlin', 13.4, 52.5, 4], ['Madrid', -3.7, 40.4, 3], ['Moscow', 37.6, 55.8, 4], ['Istanbul', 29, 41, 3],
    ['Cairo', 31.2, 30, 3], ['Lagos', 3.4, 6.5, 3], ['Nairobi', 36.8, -1.3, 2], ['Johannesburg', 28, -26, 2],
    ['Dubai', 55.3, 25.2, 3], ['Mumbai', 72.9, 19.1, 6], ['Delhi', 77.2, 28.6, 5], ['Bangalore', 77.6, 13, 3],
    ['Singapore', 103.8, 1.35, 4], ['Jakarta', 106.8, -6.2, 3], ['Bangkok', 100.5, 13.8, 3], ['Hong Kong', 114.2, 22.3, 4],
    ['Shanghai', 121.5, 31.2, 6], ['Beijing', 116.4, 39.9, 5], ['Seoul', 127, 37.6, 4], ['Tokyo', 139.7, 35.7, 9],
    ['Sydney', 151.2, -33.9, 3], ['Toronto', -79.4, 43.7, 3],
  ];
  const GW = 48, GH = 24;                 // grid cells (longitude x latitude)
  const PER_SHARD = 2500, EVENT_SCALE = 30;
  const cum = CITIES.reduce((a, c) => { a.push((a.length ? a[a.length - 1] : 0) + c[3]); return a; }, []);

  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

  // Merge the 20 shards' partial counts. Each shard holds a slice of the events; the page needs all of them.
  function aggregate(n) {
    const grid = new Float32Array(GW * GH);
    const perCity = new Array(CITIES.length).fill(0);
    let points = 0;
    for (let shard = 0; shard < PIECES; shard++) {
      const r = rng(n * 7919 + shard * 104729 + 1);
      for (let k = 0; k < PER_SHARD; k++) {
        const pick = r() * cum[cum.length - 1];
        const ci = cum.findIndex((c) => pick < c);
        const lon = CITIES[ci][1] + gauss(r) * 3.2, lat = CITIES[ci][2] + gauss(r) * 2.6;
        const gx = Math.floor(((lon + 180) / 360) * GW), gy = Math.floor(((75 - lat) / 135) * GH);
        if (gx < 0 || gx >= GW || gy < 0 || gy >= GH) continue;
        grid[gy * GW + gx] += 1; perCity[ci]++; points++;
      }
    }
    const max = Math.max(...grid);
    const top = perCity.indexOf(Math.max(...perCity));
    const top5 = [...perCity].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
    return { grid, max, points, topCity: CITIES[top][0], top5Share: top5 / points };
  }

  // ---- tiny 3D renderer (plain canvas, no libraries): rotating extruded columns ----
  const rgbOf = (cssVar) => {
    const e = document.createElement('span'); e.style.color = `var(${cssVar})`; document.body.append(e);
    const c = getComputedStyle(e).color.match(/[\d.]+/g).slice(0, 3).map(Number); e.remove(); return c;
  };
  let palette = null;
  const refreshPalette = () => { palette = { accent: rgbOf('--accent'), box: rgbOf('--box'), rule: rgbOf('--rule'), ink: rgbOf('--ink'), muted: rgbOf('--muted') }; };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refreshPalette);
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const css = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
  const ease = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
  const TILT = 0.95, MAXH = 9;

  function drawScene(app, now) {
    const cv = app.canvas, w = cv.clientWidth, hh = cv.clientHeight;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    if (!palette) refreshPalette();

    const theta = 0.35 + (now / 1000) * 0.22 + app.drag;
    const ct = Math.cos(theta), st = Math.sin(theta), cp = Math.cos(TILT), sp = Math.sin(TILT);
    const scale = Math.min((w * 0.47) / 22, (hh * 0.92) / (GH * sp + MAXH * cp + 4));
    const cx = w / 2, cy = hh * 0.6;
    const P = (x, y, z) => { const rx = x * ct - z * st, rz = x * st + z * ct; return [cx + scale * rx, cy + scale * (rz * sp - y * cp)]; };

    // floor + graticule
    const x0 = -GW / 2, x1 = GW / 2, z0 = -GH / 2, z1 = GH / 2;
    ctx.beginPath();
    [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].forEach(([x, z], i) => { const q = P(x, 0, z); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
    ctx.closePath(); ctx.fillStyle = css(palette.rule, 0.35); ctx.fill(); ctx.strokeStyle = css(palette.muted, 0.5); ctx.lineWidth = 1; ctx.stroke();
    ctx.strokeStyle = css(palette.muted, 0.22); ctx.beginPath();
    for (let gx = 4; gx < GW; gx += 4) { const a = P(x0 + gx, 0, z0), b = P(x0 + gx, 0, z1); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
    for (let gz = 4; gz < GH; gz += 4) { const a = P(x0, 0, z0 + gz), b = P(x1, 0, z0 + gz); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
    ctx.stroke();

    if (!app.data) return;
    const grow = ease((now - app.revealAt) / 800);
    const cols = [];
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
      const v = app.data.grid[gy * GW + gx];
      if (v < 1) continue;
      const t = Math.pow(v / app.data.max, 0.6);
      const xw = x0 + gx + 0.5, zw = z0 + gy + 0.5;
      cols.push({ t, h: t * MAXH * grow, x: xw, z: zw, d: xw * st + zw * ct });
    }
    cols.sort((a, b) => a.d - b.d); // far to near
    const low = mix(palette.box, palette.accent, 0.3);
    const poly = (pts, fill) => {
      ctx.beginPath(); pts.forEach((q, i) => { if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = css(palette.box, 0.55); ctx.lineWidth = 0.5; ctx.stroke();
    };
    const e = 0.46;
    for (const c of cols) {
      const base = mix(low, palette.accent, c.t), y = c.h, x = c.x, z = c.z;
      // side faces whose outward normal points toward the viewer (normal z after rotation: +x -> sin, -x -> -sin, +z -> cos, -z -> -cos)
      if (st > 0) poly([P(x + e, 0, z - e), P(x + e, 0, z + e), P(x + e, y, z + e), P(x + e, y, z - e)], css(mix(base, palette.ink, 0.28)));
      if (st < 0) poly([P(x - e, 0, z - e), P(x - e, 0, z + e), P(x - e, y, z + e), P(x - e, y, z - e)], css(mix(base, palette.ink, 0.2)));
      if (ct > 0) poly([P(x - e, 0, z + e), P(x + e, 0, z + e), P(x + e, y, z + e), P(x - e, y, z + e)], css(mix(base, palette.ink, 0.12)));
      if (ct < 0) poly([P(x - e, 0, z - e), P(x + e, 0, z - e), P(x + e, y, z - e), P(x - e, y, z - e)], css(mix(base, palette.ink, 0.2)));
      poly([P(x - e, y, z - e), P(x + e, y, z - e), P(x + e, y, z + e), P(x - e, y, z + e)], css(mix(base, [255, 255, 255], 0.12)));
    }
  }

  function buildApp(host, title) {
    host.replaceChildren();
    const progress = h('div', 'progress'); const bar = h('i'); progress.append(bar);
    const timer = h('span', 'timer', '');
    const sub = h('span', 'sub', '');
    const t = h('div', 't'); t.append(h('b', '', title), sub);
    const label = h('div', 'label'); label.append(t, timer);

    const main = h('div', 'main');
    main.append(h('h4', '', 'Live events by location, last 24 hours'));
    const stats = h('div', 'stats'); const statEls = [];
    ['Total events', 'Busiest city', 'Top 5 cities'].forEach((k) => { const c = h('div', 'stat'); c.append(h('div', 'k', k)); const v = h('div', 'v'); c.append(v); stats.append(c); statEls.push(v); });
    const canvas = h('canvas', 'scene');
    canvas.setAttribute('aria-label', 'Rotating 3D heatmap of events by location');
    const app = { data: null, revealAt: 0, drag: 0 };
    let lastX = null;
    canvas.addEventListener('pointerdown', (e) => { lastX = e.clientX; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => { if (lastX != null) { app.drag += (e.clientX - lastX) * 0.012; lastX = e.clientX; } });
    const release = () => { lastX = null; };
    canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);
    main.append(stats, canvas);

    // Whole-page loading state: nothing is usable until the last shard returns.
    const overlay = h('div', 'overlay');
    const ticks = h('div', 'ticks'); const tickEls = [];
    for (let i = 0; i < PIECES; i++) { const k = h('span', 'tick'); ticks.append(k); tickEls.push(k); }
    const ocount = h('div', 'ocount');
    const onote = h('div', 'onote');
    overlay.append(h('div', 'spinner'), h('div', 'otitle', 'Aggregating 20 shards…'), ticks, ocount, onote);

    const body = h('div', 'body'); body.append(main, overlay);
    const why = h('div', 'why');
    const tally = h('div', 'tally');
    host.append(progress, label, body, why, tally);
    return Object.assign(app, { host, bar, progress, timer, sub, statEls, canvas, tally, why, ocount, onote, tickEls });
  }

  const apps = {};

  function setWaiting(app) {
    app.host.classList.add('loading');
    app.progress.classList.remove('finished');
    app.bar.style.width = '0%';
    app.statEls.forEach((v) => v.replaceChildren(h('span', 'sk s')));
    app.data = null;
    app.tickEls.forEach((k) => { k.className = 'tick'; });
    app.why.replaceChildren();
    app.timer.className = 'timer';
  }

  // Merge the 20 partial results; every column and total needs all of them, so this runs once, at the end.
  function showPage(app, shards, n) {
    app.data = aggregate(n);
    app.revealAt = performance.now();
    const d = app.data;
    app.statEls[0].replaceChildren(h('span', 'fade', ((d.points * EVENT_SCALE) / 1e6).toFixed(2) + ' M'));
    app.statEls[1].replaceChildren(h('span', 'fade', d.topCity));
    app.statEls[2].replaceChildren(h('span', 'fade', Math.round(d.top5Share * 100) + '%'));
    app.host.classList.remove('loading');
    const sorted = shards.map((x) => x[0]).sort((a, b) => a - b);
    const rescued = shards.filter((x) => x[1] === 1).length;
    app.why.replaceChildren(
      document.createTextNode('Slowest shard '), h('em', '', ms(sorted[sorted.length - 1])), document.createTextNode(' · median shard '), h('em', '', ms(sorted[Math.floor(sorted.length / 2)])),
      ...(rescued ? [document.createTextNode(` · ${rescued} rescued by a backup`)] : []),
    );
  }

  const demo = (() => {
    let traces = null;      // per policy, paired by index
    let deck = [];
    let run = null;         // current page load
    let loads = 0;
    let tally = null;
    let nextAt = 0;         // performance.now() time to auto-start the next load

    function reset() {
      const t = { none: by('none').traces, adaptive: by('adaptive').traces };
      traces = t.none.length && t.none.length === t.adaptive.length ? t : null;
      for (const id of ['none', 'adaptive']) {
        apps[id] = buildApp($('#app-' + id), id === 'none' ? 'Without hedging' : 'With adaptive hedging');
        apps[id].sub.textContent = `typical ${ms(by(id).user.p50)} · slowest 1% ${ms(by(id).user.p99)}`;
      }
      tally = { none: { n: 0, slow: 0, all: [] }, adaptive: { n: 0, slow: 0, all: [] } };
      loads = 0; deck = []; run = null; nextAt = 0;
      for (const id of ['none', 'adaptive']) { setWaiting(apps[id]); renderTally(id); }
      if (!traces) { for (const id of ['none', 'adaptive']) apps[id].timer.textContent = 'no data'; return; }
      const lat = traces.none.map((t, i) => [Math.max(...t.shards.map((x) => x[0])), i]).sort((a, b) => b[0] - a[0]);
      slowest = lat.map((x) => x[1]);
      slowPool = lat.filter((x) => x[0] > SLOW_MS).map((x) => x[1]);
      $('#affected').textContent = Math.round((100 * slowPool.length) / lat.length);
      start(slowest[0]); // open with the slowest recorded load so the contrast is obvious

    }

    function pick() {
      if (!deck.length) {
        deck = (shownPool()).slice();
        for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
      }
      return deck.pop();
    }

    // Recorded loads ordered from slowest to fastest without hedging.
    let slowest = [];
    let slowPool = [];
    // By default replay loads that were slow without hedging; the rest are fast either way.
    const shownPool = () => ($('#fast').checked || slowPool.length < 5 ? traces.none.map((_, i) => i) : slowPool);

    function start(forceIdx) {
      if (!traces) return;
      loads += 1;
      run = { idx: forceIdx != null ? forceIdx : pick(), t0: performance.now(), n: loads, done: { none: false, adaptive: false }, filled: { none: new Set(), adaptive: new Set() } };
      for (const id of ['none', 'adaptive']) setWaiting(apps[id]);
      nextAt = 0;
    }

    function renderTally(id) {
      const t = tally[id];
      const el = apps[id].tally;
      el.replaceChildren();
      if (!t.n) { el.textContent = 'No loads yet'; return; }
      const sorted = [...t.all].sort((a, b) => a - b);
      el.append(document.createTextNode(`${t.n} ${t.n === 1 ? 'load' : 'loads'} · median `), h('em', '', ms(sorted[Math.floor(sorted.length / 2)])),
        document.createTextNode(' · over 1 s: '), h('em', '', `${t.slow} of ${t.n}`));
    }

    function frame(ts) {
      for (const id of ['none', 'adaptive']) if (apps[id]) drawScene(apps[id], ts);
      if (run) {
        const speed = $('#slow').checked ? 0.25 : 1;
        const elapsed = (ts - run.t0) * speed;
        for (const id of ['none', 'adaptive']) {
          if (run.done[id]) continue;
          const shards = traces[id][run.idx].shards;
          const total = Math.max(...shards.map((x) => x[0]));
          const app = apps[id];
          let count = 0;
          shards.forEach((x, i) => {
            if (x[0] <= elapsed) { count++; if (!run.filled[id].has(i)) { run.filled[id].add(i); app.tickEls[i].className = 'tick on' + (x[1] === 1 ? ' rescued' : ''); } }
          });
          app.bar.style.width = (100 * count) / shards.length + '%';
          if (elapsed >= total) {
            run.done[id] = true;
            showPage(app, shards, run.n);
            app.timer.replaceChildren(document.createTextNode(secs(total)), h('small', '', 'page ready'));
            app.timer.className = 'timer ' + (total > SLOW_MS ? 'slow' : 'done');
            app.progress.classList.add('finished');
            const t = tally[id]; t.n++; t.all.push(total); if (total > SLOW_MS) t.slow++;
            renderTally(id);
          } else {
            const left = PIECES - count;
            app.ocount.textContent = `${count} of ${PIECES} shards returned`;
            app.onote.textContent = left === 1 ? 'waiting for the last shard' : `waiting for ${left} shards`;
            app.timer.replaceChildren(document.createTextNode(secs(elapsed)), h('small', '', 'loading'));
          }
        }
        if (run.done.none && run.done.adaptive) { run = null; nextAt = ts + 1300; }
      } else if (nextAt && $('#auto').checked && ts >= nextAt) {
        start();
      }
      requestAnimationFrame(frame);
    }

    $('#reload').addEventListener('click', () => start());
    $('#fast').addEventListener('change', () => { deck = []; });
    $('#auto').addEventListener('change', () => { if ($('#auto').checked && !run && traces) nextAt = performance.now() + 300; });
    requestAnimationFrame(frame);
    return { reset };
  })();

  // ------------------------------------------- Figure 2: scatter of requests
  const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];

  function drawScatter() {
    const dur = last.config.duration_s, warm = last.config.warmup_s, shift = last.shift_time_s;
    const sample = (id) => by(id).samples.map(([t, l, hd]) => ({ t, l, h: hd }));
    const data = { none: sample('none'), adaptive: sample('adaptive') };
    const all = [...data.none, ...data.adaptive].map((d) => d.l);
    const lo = Math.log10(Math.max(1, Math.min(...all) / 1.3)), hi = Math.log10(Math.max(...all) * 1.2);

    for (const [id, bottom] of [['none', false], ['adaptive', true]]) {
      const host = $('#chart-' + id);
      const W = Math.max(320, host.clientWidth), H = bottom ? 190 : 160;
      const m = { l: 52, r: 10, t: 6, b: bottom ? 32 : 8 };
      const X = (t) => m.l + ((t - warm) / (dur - warm)) * (W - m.l - m.r);
      const Y = (v) => H - m.b - ((Math.log10(v) - lo) / (hi - lo)) * (H - m.t - m.b);
      const s = svg('svg', { viewBox: `0 0 ${W} ${H}` });
      for (const v of [10, 100, 1000, 10000]) {
        const l = Math.log10(v);
        if (l < lo || l > hi) continue;
        s.append(svg('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }));
        s.append(svg('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, v >= 1000 ? v / 1000 + ' s' : v + ' ms'));
      }
      s.append(svg('line', { class: 'sla', x1: m.l, x2: W - m.r, y1: Y(SLOW_MS), y2: Y(SLOW_MS) }));
      s.append(svg('text', { x: W - m.r - 2, y: Y(SLOW_MS) - 4, 'text-anchor': 'end' }, '1 s'));
      s.append(svg('line', { class: 'axis', x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }));
      if (bottom) {
        for (let t = 30; t <= dur; t += 30) s.append(svg('text', { x: X(t), y: H - 16, 'text-anchor': 'middle' }, t));
        s.append(svg('text', { x: (m.l + W - m.r) / 2, y: H - 2, 'text-anchor': 'middle' }, 'arrival time (s)'));
      }
      if (last.ui.surge > 0) {
        s.append(svg('line', { class: 'shift', x1: X(shift), x2: X(shift), y1: m.t, y2: H - m.b }));
        s.append(svg('text', { x: X(shift) + 5, y: m.t + 10 }, `traffic +${last.ui.surge}%`));
      }
      let slow = 0;
      for (const d of data[id]) {
        const isSlow = d.l > SLOW_MS; if (isSlow) slow++;
        s.append(svg('circle', { class: 'dot' + (d.h ? ' hedged' : '') + (isSlow ? ' slow' : ''), cx: X(d.t).toFixed(1), cy: Y(d.l).toFixed(1), r: 2.3 }));
      }
      host.replaceChildren(s);
      const sorted = data[id].map((d) => d.l).sort((a, b) => a - b);
      $('#stat-' + id).replaceChildren(
        document.createTextNode('p99 '), h('em', '', ms(percentile(sorted, 0.99))),
        document.createTextNode(' · '), h('em', '', Math.round((100 * slow) / data[id].length) + '%'),
        document.createTextNode(' over 1 s'),
      );
    }
  }

  // --------------------------------------------------------------- wiring
  $('#controls').addEventListener('submit', (e) => e.preventDefault());
  $('#again').addEventListener('click', () => { seed += 1; load(); });
  let rz;
  new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(() => { if (last) drawScatter(); }, 150); }).observe(document.body);
  load();
})();
