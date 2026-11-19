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
  // Backend scale for the demo: ~30 ms calls, 30 shards (4 cards + 6 bars + 20 rows), 3 minutes of traffic.
  // Servers stall 3% of the time at 40x slower: a deliberately severe setting so the effect is easy to see.
  const SCALE = { fanout: 30, service_median_ms: 30, episode_ms: 700, duration_s: 180, warmup_s: 15, slow_fraction: 0.03, slow_factor: 40 };
  const PIECES = 30;
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
    const hl = $('#headline');
    hl.replaceChildren(
      document.createTextNode('A typical page takes '), h('span', 'bad', ms(n.user.p50)), document.createTextNode(' to load without hedging and '),
      h('span', 'good', ms(a.user.p50)), document.createTextNode(' with it. '),
      h('span', 'bad', pct(over('none'))), document.createTextNode(' of pages take over a second, against '),
      h('span', 'good', pct(over('adaptive'))), document.createTextNode('.'),
    );
  }

  // ------------------------------------------------- Figure 1: dashboard demo
  const KPI = ['MRR', 'Active users', 'Churn', 'Open trials'];
  const MONTHS = ['Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov'];
  const COMPANIES = ['Northwind', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark Labs', 'Wayne Corp', 'Acme', 'Soylent', 'Vandelay', 'Cyberdyne', 'Tyrell', 'Massive Dynamic', 'Oscorp', 'Pied Piper', 'Aperture', 'Wonka', 'Gringotts', 'Dunder Mifflin', 'Bluth Co.'];
  const PLANS = ['Starter', 'Team', 'Business', 'Enterprise'];
  const STATUS = ['Active', 'Active', 'Active', 'Trial', 'Past due'];
  const hash = (a, b) => { let x = (a * 374761393 + b * 668265263) >>> 0; x = ((x ^ (x >>> 13)) * 1274126177) >>> 0; return (x ^ (x >>> 16)) >>> 0; };
  const money = (n) => '$' + n.toLocaleString('en-US');

  // Placeholder content, different on every load. Only the timing is real.
  const content = {
    kpi: (i, n) => [money(48000 + (hash(i, n) % 9000)), (12000 + (hash(i, n) % 2500)).toLocaleString('en-US'), (1 + (hash(i, n) % 30) / 10).toFixed(1) + '%', String(20 + (hash(i, n) % 40))][i],
    bar: (j, n) => 35 + (hash(j + 10, n) % 60),
    row: (r, n) => {
      const k = hash(r + 20, n);
      return [COMPANIES[(r * 2 + n) % COMPANIES.length], PLANS[k % 4], money(200 + (k % 4800)), STATUS[(k >>> 3) % 5]];
    },
  };

  function buildApp(host, title) {
    host.replaceChildren();
    const progress = h('div', 'progress'); const bar = h('i'); progress.append(bar);
    const timer = h('span', 'timer', '');
    const sub = h('span', 'sub', '');
    const t = h('div', 't'); t.append(h('b', '', title), sub);
    const label = h('div', 'label'); label.append(t, timer);

    const nav = h('nav'); ['Overview', 'Customers', 'Billing', 'Reports'].forEach((t, i) => nav.append(h('span', i ? '' : 'on', t)));
    const main = h('div', 'main');
    main.append(h('h4', '', 'Overview'));

    const kpis = h('div', 'kpis'); const kpiEls = [];
    KPI.forEach((k) => { const c = h('div', 'kpi'); c.append(h('div', 'k', k)); const v = h('div', 'v'); c.append(v); kpis.append(c); kpiEls.push(v); });

    const cb = h('div', 'chart-box'); cb.append(h('div', 'k', 'Revenue by month'));
    const bars = h('div', 'bars'); const barEls = [];
    MONTHS.forEach(() => { const b = h('div', 'bar'); b.append(h('div', 'fill')); bars.append(b); barEls.push(b); });
    const months = h('div', 'months'); MONTHS.forEach((m) => months.append(h('span', '', m)));
    cb.append(bars, months);

    const table = h('table', 'rows');
    const thead = h('thead'); const hr = h('tr'); ['Customer', 'Plan', 'MRR', 'Status'].forEach((t) => hr.append(h('th', '', t))); thead.append(hr);
    const tbody = h('tbody'); const rowEls = [];
    for (let r = 0; r < 20; r++) { const tr = h('tr'); for (let c = 0; c < 4; c++) tr.append(h('td', c === 2 ? 'num' : '')); tbody.append(tr); rowEls.push(tr); }
    table.append(thead, tbody);

    main.append(kpis, cb, table);
    const body = h('div', 'body'); body.append(nav, main);
    const tally = h('div', 'tally');
    host.append(progress, label, body, tally);
    return { bar, progress, timer, sub, kpiEls, barEls, rowEls, tally };
  }

  const apps = {};

  function setWaiting(app) {
    app.progress.classList.remove('finished');
    app.bar.style.width = '0%';
    app.kpiEls.forEach((v) => v.replaceChildren(h('span', 'sk s')));
    app.barEls.forEach((b) => { b.classList.add('wait'); b.firstChild.style.height = ''; b.firstChild.style.boxShadow = ''; });
    app.rowEls.forEach((tr) => [...tr.children].forEach((td, c) => td.replaceChildren(h('span', 'sk' + (c === 0 ? ' l' : c === 3 ? ' s' : '')))));
    app.timer.className = 'timer';
  }

  function fillPiece(app, i, rescued, n) {
    if (i < 4) {
      const v = app.kpiEls[i];
      v.replaceChildren(h('span', 'fade', content.kpi(i, n)));
      if (rescued) v.prepend(h('span', 'rescued'));
    } else if (i < 10) {
      const b = app.barEls[i - 4];
      b.classList.remove('wait');
      b.firstChild.style.height = content.bar(i - 4, n) + '%';
      b.firstChild.style.boxShadow = rescued ? 'inset 0 3px 0 var(--accent)' : '';
    } else {
      const tr = app.rowEls[i - 10];
      const [name, plan, mrr, status] = content.row(i - 10, n);
      const cells = [...tr.children];
      cells[0].replaceChildren(...(rescued ? [h('span', 'rescued')] : []), document.createTextNode(name));
      cells[1].textContent = plan;
      cells[2].textContent = mrr;
      cells[3].replaceChildren(h('span', 'pill', status));
    }
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
      slowest = traces.none.map((t, i) => [Math.max(...t.shards.map((x) => x[0])), i]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
      start(slowest[0]); // open with the slowest recorded load so the contrast is obvious

    }

    function pick() {
      if (!deck.length) {
        deck = traces.none.map((_, i) => i);
        for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
      }
      return deck.pop();
    }

    // Recorded loads ordered from slowest to fastest without hedging.
    let slowest = [];

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
      if (run) {
        const speed = $('#slow').checked ? 0.25 : 1;
        const elapsed = (ts - run.t0) * speed;
        for (const id of ['none', 'adaptive']) {
          if (run.done[id]) continue;
          const shards = traces[id][run.idx].shards;
          const total = Math.max(...shards.map((s) => s[0]));
          let count = 0;
          shards.forEach((s, i) => {
            if (s[0] <= elapsed) { count++; if (!run.filled[id].has(i)) { run.filled[id].add(i); fillPiece(apps[id], i, s[1] === 1, run.n); } }
          });
          const app = apps[id];
          app.bar.style.width = (100 * count) / shards.length + '%';
          if (elapsed >= total) {
            run.done[id] = true;
            app.timer.replaceChildren(document.createTextNode(secs(total)), h('small', '', 'loaded'));
            app.timer.className = 'timer ' + (total > SLOW_MS ? 'slow' : 'done');
            app.progress.classList.add('finished');
            const t = tally[id]; t.n++; t.all.push(total); if (total > SLOW_MS) t.slow++;
            renderTally(id);
          } else {
            app.timer.replaceChildren(document.createTextNode(secs(elapsed)), h('small', '', `${count} of ${PIECES} loaded`));
          }
        }
        if (run.done.none && run.done.adaptive) { run = null; nextAt = ts + 1300; }
      } else if (nextAt && $('#auto').checked && ts >= nextAt) {
        start();
      }
      requestAnimationFrame(frame);
    }

    $('#reload').addEventListener('click', () => start());
    $('#worst').addEventListener('click', () => { if (traces) start(slowest[Math.floor(Math.random() * Math.max(1, Math.ceil(slowest.length / 10)))]); });
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
