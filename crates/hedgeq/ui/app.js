(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };

  const SLOW_MS = 200;   // "slow request" threshold used for dark dots and the live counter
  const SPEED = 5;       // simulated seconds per real second
  const HOLD = 2.5;      // seconds to hold the finished picture before looping
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ms = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + ' s' : Math.round(v) + ' ms');

  const ROWS = [
    { id: 'adaptive', name: 'Adaptive delay (hedgeq)' },
    { id: 'fixed_capped', name: 'Fixed delay' },
    { id: 'none', name: 'No hedging' },
  ];

  const playBtn = $('#play');
  let seed = 1;
  let last = null;       // last API response
  let scenes = null;     // per-panel drawing state
  let pos = 0;
  let playing = !reduced;
  let holdLeft = 0;
  let prevTs = null;
  const by = (id) => last.results.find((r) => r.id === id);

  // ------------------------------------------------------------------ data
  async function load() {
    const surge = +$('#in-surge').value, budget = +$('#in-budget').value;
    $('#load').disabled = $('#again').disabled = true;
    try {
      const res = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seed, surge_factor: 1 + surge / 100, budget: budget / 100 }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'request failed');
      last = body;
      last.ui = { surge, budget };
      renderText();
      buildScenes();
      // A link such as /#t=40 shows a still frame at that second (handy for sharing or printing).
      const still = /^#t=(\d+)$/.exec(location.hash);
      if (still) { playing = false; playBtn.textContent = 'Play'; }
      pos = still ? Math.min(+still[1], last.config.duration_s) : reduced ? last.config.duration_s : scenes.start;
      holdLeft = 0;
      frame(true);
    } catch (e) {
      $('#result').textContent = 'Error: ' + e.message;
    } finally {
      $('#load').disabled = $('#again').disabled = false;
    }
  }

  function renderText() {
    const { surge, budget } = last.ui;
    $('#seed').textContent = seed;
    $('#exp-budget').textContent = budget;
    $('#exp-shift').textContent = surge > 0
      ? `At the midpoint of the run, request volume increases by ${surge}%.`
      : 'Request volume stays constant throughout the run.';

    const best = Math.min(...ROWS.map((r) => by(r.id).user.p999));
    $('#tbl tbody').replaceChildren(...ROWS.map((r) => {
      const x = by(r.id);
      const tr = document.createElement('tr');
      const cells = [r.name, ms(x.user.p999), r.id === 'none' ? '0%' : x.extra_pct.toFixed(1) + '%'].map((t) => {
        const td = document.createElement('td');
        td.textContent = t;
        return td;
      });
      if (x.user.p999 === best) cells[1].className = 'best';
      tr.append(...cells);
      return tr;
    }));

    const a = by('adaptive'), f = by('fixed_capped'), n = by('none');
    const ratio = f.user.p999 / a.user.p999;
    const lead = ratio >= 1.1
      ? `With the same ${budget}% budget, the adaptive delay reduces the 99.9th-percentile latency to ${ms(a.user.p999)}, ${ratio.toFixed(1)} times lower than the fixed delay (${ms(f.user.p999)}) and ${(n.user.p999 / a.user.p999).toFixed(1)} times lower than no hedging (${ms(n.user.p999)}).`
      : `Under these conditions the adaptive delay (${ms(a.user.p999)}) and the fixed delay (${ms(f.user.p999)}) are within 10% of each other.`;
    $('#result').textContent = `${lead} Adaptive hedging sent ${a.extra_pct.toFixed(1)}% extra requests, within its limit.`;
  }

  // -------------------------------------------------------------- drawing
  function buildScenes() {
    const dur = last.config.duration_s, warm = last.config.warmup_s, shift = last.shift_time_s;
    const sample = (id) => by(id).samples.map(([t, l, h]) => ({ t, l, h })).sort((a, b) => a.t - b.t);
    const data = { none: sample('none'), adaptive: sample('adaptive') };
    const all = [...data.none, ...data.adaptive].map((d) => d.l);
    const lo = Math.log10(Math.max(1, Math.min(...all) / 1.3)), hi = Math.log10(Math.max(...all) * 1.2);
    scenes = { dur, warm, start: warm, panels: [] };

    for (const [id, last_] of [['none', false], ['adaptive', true]]) {
      const host = $('#chart-' + id);
      const W = Math.max(320, host.clientWidth), H = last_ ? 190 : 160;
      const m = { l: 52, r: 10, t: 6, b: last_ ? 32 : 8 };
      const X = (t) => m.l + ((t - warm) / (dur - warm)) * (W - m.l - m.r);
      const Y = (v) => H - m.b - ((Math.log10(v) - lo) / (hi - lo)) * (H - m.t - m.b);
      const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });
      for (const v of [10, 100, 1000]) {
        const l = Math.log10(v);
        if (l < lo || l > hi) continue;
        svg.append(el('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }));
        svg.append(el('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, v >= 1000 ? v / 1000 + ' s' : v + ' ms'));
      }
      svg.append(el('line', { class: 'sla', x1: m.l, x2: W - m.r, y1: Y(SLOW_MS), y2: Y(SLOW_MS) }));
      svg.append(el('text', { x: W - m.r - 2, y: Y(SLOW_MS) - 4, 'text-anchor': 'end' }, `${SLOW_MS} ms`));
      svg.append(el('line', { class: 'axis', x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }));
      if (last_) {
        for (let t = 10; t <= dur; t += 10) svg.append(el('text', { x: X(t), y: H - 16, 'text-anchor': 'middle' }, t));
        svg.append(el('text', { x: (m.l + W - m.r) / 2, y: H - 2, 'text-anchor': 'middle' }, 'arrival time (s)'));
      }
      if (last.ui.surge > 0) {
        svg.append(el('line', { class: 'shift', x1: X(shift), x2: X(shift), y1: m.t, y2: H - m.b }));
        svg.append(el('text', { x: X(shift) + 5, y: m.t + 10 }, `traffic +${last.ui.surge}%`));
      }
      const dots = el('g');
      const head = el('line', { class: 'head', y1: m.t, y2: H - m.b });
      svg.append(dots, head);
      host.replaceChildren(svg);
      scenes.panels.push({ id, data: data[id], X, Y, dots, head, shown: 0, lat: [], slow: 0 });
    }
  }

  function percentile(sorted, p) {
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  }

  function frame(force) {
    if (!scenes) return;
    for (const P of scenes.panels) {
      if (pos < P.lastPos || force) { P.dots.replaceChildren(); P.shown = 0; P.lat = []; P.slow = 0; }
      P.lastPos = pos;
      P.head.setAttribute('x1', P.X(pos)); P.head.setAttribute('x2', P.X(pos));
      let added = false;
      while (P.shown < P.data.length && P.data[P.shown].t <= pos) {
        const d = P.data[P.shown++];
        const slow = d.l > SLOW_MS;
        P.dots.append(el('circle', { class: 'dot' + (d.h ? ' hedged' : '') + (slow ? ' slow' : ''), cx: P.X(d.t).toFixed(1), cy: P.Y(d.l).toFixed(1), r: 2.3 }));
        P.lat.push(d.l);
        if (slow) P.slow++;
        added = true;
      }
      if (added || force) {
        const n = P.lat.length;
        const sorted = [...P.lat].sort((a, b) => a - b);
        $('#stat-' + P.id).replaceChildren(
          document.createTextNode(n ? 'p99 ' : ''),
          Object.assign(document.createElement('em'), { textContent: n ? ms(percentile(sorted, 0.99)) : '' }),
          document.createTextNode(n ? ' · ' : ''),
          Object.assign(document.createElement('em'), { textContent: n ? Math.round((100 * P.slow) / n) + '%' : '' }),
          document.createTextNode(n ? ` over ${SLOW_MS} ms` : ''),
        );
      }
    }
  }

  function tick(ts) {
    if (playing && scenes) {
      const dt = prevTs == null ? 0 : Math.min(0.1, (ts - prevTs) / 1000);
      if (holdLeft > 0) {
        holdLeft -= dt;
        if (holdLeft <= 0) pos = scenes.start;
      } else {
        pos += dt * SPEED;
        if (pos >= scenes.dur) { pos = scenes.dur; holdLeft = HOLD; }
      }
      frame(false);
    }
    prevTs = ts;
    requestAnimationFrame(tick);
  }

  // --------------------------------------------------------------- wiring
  const bind = (inp, out, fmt) => $(inp).addEventListener('input', () => { $(out).textContent = fmt($(inp).value); });
  bind('#in-surge', '#out-surge', (v) => (+v ? '+' + v + '%' : '0%'));
  bind('#in-budget', '#out-budget', (v) => v + '%');
  $('#controls').addEventListener('submit', (e) => { e.preventDefault(); load(); });
  $('#again').addEventListener('click', () => { seed += 1; load(); });
  if (reduced) playBtn.hidden = true;
  playBtn.addEventListener('click', () => { playing = !playing; playBtn.textContent = playing ? 'Pause' : 'Play'; });
  let rz;
  new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(() => { if (last) { buildScenes(); frame(true); } }, 120); }).observe(document.body);
  requestAnimationFrame(tick);
  load();
})();
