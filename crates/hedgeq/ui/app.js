/* hedgeq lab. Vanilla JS, no dependencies, no network requests except /api/*. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const SVGNS = 'http://www.w3.org/2000/svg';

  // ---------------------------------------------------------------- utilities
  function h(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid);
    return n;
  }
  function s(tag, attrs = {}, ...kids) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    for (const kid of kids.flat()) if (kid != null) n.append(kid);
    return n;
  }
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } },
  };
  function fmtMs(v) {
    if (v == null || !isFinite(v)) return '–';
    if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + ' s';
    if (v >= 100) return Math.round(v) + ' ms';
    if (v >= 10) return v.toFixed(0) + ' ms';
    return v.toFixed(1) + ' ms';
  }
  const fmtPct = (v, d = 1) => (v == null || !isFinite(v) ? '–' : v.toFixed(d) + '%');

  // ------------------------------------------------------------------- theme
  const root = document.documentElement;
  const savedTheme = store.get('hedgeq-theme');
  if (savedTheme === 'light' || savedTheme === 'dark') root.dataset.theme = savedTheme;
  $('#theme').addEventListener('click', () => {
    const dark = root.dataset.theme
      ? root.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    store.set('hedgeq-theme', root.dataset.theme);
    if (lastRun) renderAll();
    renderCalc();
  });

  // ------------------------------------------------------------ chart engine
  /**
   * Minimal SVG line chart with log/linear y, shared hover tooltip, bands,
   * vertical markers and horizontal reference lines.
   */
  const charts = new Map();

  function niceLinearTicks(lo, hi, n = 5) {
    const span = hi - lo || 1;
    const raw = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) || mag * 10;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function logTicks(lo, hi) {
    const out = [];
    for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
      for (const m of [1, 2, 5]) {
        const v = m * Math.pow(10, e);
        if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
      }
    }
    return out;
  }

  function drawChart(host, o) {
    const W = Math.max(280, host.clientWidth || 600);
    const H = o.height || 300;
    const m = { l: (o.yLog ? 54 : 46) + (o.yTitle ? 14 : 0), r: 14, t: 12, b: 38 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const vis = o.series.filter((x) => !hidden.has(x.id) && x.pts.some((p) => p[1] != null));

    let [x0, x1] = o.xDomain;
    let y0 = Infinity, y1 = -Infinity;
    for (const ser of vis) for (const p of ser.pts) if (p[1] != null) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    if (o.refLines) for (const r of o.refLines) { y0 = Math.min(y0, r.y); y1 = Math.max(y1, r.y); }
    if (!isFinite(y0)) { y0 = o.yLog ? 1 : 0; y1 = o.yLog ? 10 : 1; }
    if (o.yLog) { y0 = Math.max(0.1, y0 / 1.15); y1 = y1 * 1.15; }
    else { y0 = o.yMin != null ? o.yMin : Math.min(0, y0); y1 = y1 + (y1 - y0) * 0.1 || 1; }

    const X = (v) => m.l + ((v - x0) / (x1 - x0)) * iw;
    const Y = o.yLog
      ? (v) => m.t + ih - ((Math.log10(v) - Math.log10(y0)) / (Math.log10(y1) - Math.log10(y0))) * ih
      : (v) => m.t + ih - ((v - y0) / (y1 - y0)) * ih;

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true' });
    const yt = o.yLog ? logTicks(y0, y1) : niceLinearTicks(y0, y1, 5);
    const xt = o.xTicks.filter(([v]) => v >= x0 - 1e-9 && v <= x1 + 1e-9);

    const grid = s('g', { class: 'grid' });
    for (const v of yt) grid.append(s('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }));
    svg.append(grid);

    for (const b of o.bands || []) {
      svg.append(s('rect', { class: 'band', x: X(b.x0), y: m.t, width: Math.max(0, X(b.x1) - X(b.x0)), height: ih }));
      if (b.label) svg.append(s('text', { class: 'axis-title', x: X(b.x0) + 6, y: m.t + 14 }, document.createTextNode(b.label)));
    }

    const axis = s('g', { class: 'axis' });
    for (const v of yt) {
      const t = s('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' });
      t.textContent = (o.fmtY || String)(v);
      axis.append(t);
    }
    for (const [v, label] of xt) {
      const t = s('text', { x: X(v), y: H - m.b + 18, 'text-anchor': 'middle' });
      t.textContent = label;
      axis.append(t);
    }
    svg.append(axis);
    if (o.xTitle) {
      const t = s('text', { class: 'axis-title', x: m.l + iw / 2, y: H - 4, 'text-anchor': 'middle' });
      t.textContent = o.xTitle;
      svg.append(t);
    }
    if (o.yTitle) {
      const t = s('text', { class: 'axis-title', transform: `translate(11 ${m.t + ih / 2}) rotate(-90)`, 'text-anchor': 'middle' });
      t.textContent = o.yTitle;
      svg.append(t);
    }

    for (const mk of o.markers || []) {
      const g = s('g', { class: 'marker' });
      g.append(s('line', { x1: X(mk.x), x2: X(mk.x), y1: m.t, y2: m.t + ih }));
      const t = s('text', { x: X(mk.x) + 6, y: m.t + 14 });
      t.textContent = mk.label;
      g.append(t);
      svg.append(g);
    }
    for (const r of o.refLines || []) {
      const g = s('g', { class: 'hline' });
      g.append(s('line', { x1: m.l, x2: W - m.r, y1: Y(r.y), y2: Y(r.y) }));
      const t = s('text', { x: W - m.r - 4, y: Y(r.y) - 5, 'text-anchor': 'end' });
      t.textContent = r.label;
      g.append(t);
      svg.append(g);
    }

    for (const ser of vis) {
      let d = '';
      let pen = false;
      for (const [x, y] of ser.pts) {
        if (y == null) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${X(x).toFixed(1)} ${Y(y).toFixed(1)}`;
        pen = true;
      }
      const path = s('path', { class: 'series', d, stroke: `var(--c-${ser.id})` });
      if (ser.dash) path.setAttribute('stroke-dasharray', ser.dash);
      if (ser.id === 'adaptive') path.setAttribute('stroke-width', '2.8');
      svg.append(path);
    }

    // hover layer
    const cross = s('line', { class: 'cross', y1: m.t, y2: m.t + ih, visibility: 'hidden' });
    const dots = new Map(vis.map((ser) => [ser.id, s('circle', { r: 4.5, fill: `var(--c-${ser.id})`, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' })]));
    svg.append(cross, ...dots.values());
    const hit = s('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' });
    svg.append(hit);

    host.replaceChildren(svg);
    const tip = h('div', { class: 'tip' });
    tip.hidden = true;
    host.append(tip);

    const nearest = (pts, x) => {
      let best = null, bd = Infinity;
      for (const p of pts) {
        if (p[1] == null) continue;
        const d = Math.abs(p[0] - x);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    };
    const onMove = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const xv = x0 + ((px - m.l) / iw) * (x1 - x0);
      let anchor = null;
      const rows = [];
      for (const ser of vis) {
        const p = nearest(ser.pts, xv);
        if (!p) continue;
        anchor = anchor == null || Math.abs(p[0] - xv) < Math.abs(anchor - xv) ? p[0] : anchor;
        rows.push([ser, p]);
      }
      if (!rows.length) return;
      cross.setAttribute('x1', X(anchor)); cross.setAttribute('x2', X(anchor)); cross.setAttribute('visibility', 'visible');
      for (const [ser, p] of rows) {
        const c = dots.get(ser.id);
        c.setAttribute('cx', X(p[0])); c.setAttribute('cy', Y(p[1])); c.setAttribute('visibility', 'visible');
      }
      tip.replaceChildren(
        h('div', { class: 't', text: o.tipTitle(anchor) }),
        ...rows.sort((a, b) => b[1][1] - a[1][1]).map(([ser, p]) => {
          const sw = h('i'); sw.style.setProperty('--c', `var(--c-${ser.id})`);
          return h('div', { class: 'r' }, h('span', {}, sw, ser.label), h('b', { text: (o.fmtTip || o.fmtY || String)(p[1]) }));
        }),
      );
      tip.hidden = false;
      const left = (X(anchor) / W) * r.width;
      const flip = left > r.width * 0.6;
      tip.style.left = flip ? `${Math.max(0, left - tip.offsetWidth - 14)}px` : `${left + 14}px`;
      tip.style.top = `${m.t + 6}px`;
    };
    const onLeave = () => {
      tip.hidden = true;
      cross.setAttribute('visibility', 'hidden');
      for (const c of dots.values()) c.setAttribute('visibility', 'hidden');
    };
    hit.addEventListener('pointermove', onMove);
    hit.addEventListener('pointerleave', onLeave);
  }

  function chart(id, o) {
    const host = $('#' + id);
    charts.set(id, { host, o });
    drawChart(host, o);
  }
  new ResizeObserver(() => { for (const { host, o } of charts.values()) drawChart(host, o); }).observe(document.body);

  // ------------------------------------------------- problem: fan-out calculator
  const calcP = $('#calc-p'), calcN = $('#calc-n');
  const pFromSlider = (v) => Math.pow(10, -4 + (v / 100) * (Math.log10(0.1) + 4)); // 0.01% .. 10%
  const nFromSlider = (v) => Math.max(1, Math.round(Math.pow(10, (v / 100) * Math.log10(2000))));
  function renderCalc() {
    const p = pFromSlider(+calcP.value), n = nFromSlider(+calcN.value);
    const prob = 1 - Math.pow(1 - p, n);
    $('#calc-p-o').textContent = (p * 100 < 1 ? (p * 100).toFixed(2) : (p * 100).toFixed(1)) + '%';
    $('#calc-n-o').textContent = n.toLocaleString();
    $('#calc-big').textContent = (prob * 100 < 10 ? (prob * 100).toFixed(1) : Math.round(prob * 100)) + '%';
    $('#calc-cap').textContent = `of requests touching ${n.toLocaleString()} servers will wait on at least one slow server, even though only ${(p * 100 < 1 ? (p * 100).toFixed(2) : (p * 100).toFixed(1))}% of single-server calls are slow.`;
    const pts = (pp) => Array.from({ length: 60 }, (_, i) => {
      const nn = Math.round(Math.pow(10, (i / 59) * Math.log10(2000)));
      return [Math.log10(nn), (1 - Math.pow(1 - pp, nn)) * 100];
    });
    const ser = [
      { id: 'none', label: 'Your slider', pts: pts(p) },
      { id: 'fixed', label: '1 in 1,000 slow', pts: pts(0.001), dash: '5 4' },
      { id: 'fixed_capped', label: '1 in 100 slow', pts: pts(0.01), dash: '5 4' },
    ];
    chart('calc-chart', {
      series: ser, height: 260, yLog: false, yMin: 0, xDomain: [0, Math.log10(2000)],
      xTicks: [[0, '1'], [1, '10'], [2, '100'], [3, '1,000']],
      fmtY: (v) => Math.round(v) + '%', fmtTip: (v) => v.toFixed(1) + '%',
      xTitle: 'servers per request (fan-out)', yTitle: 'P(request is slow)',
      markers: [{ x: Math.log10(n), label: `N = ${n.toLocaleString()}` }],
      tipTitle: (x) => `N ≈ ${Math.round(Math.pow(10, x)).toLocaleString()} servers`,
    });
  }
  calcP.addEventListener('input', renderCalc);
  calcN.addEventListener('input', renderCalc);

  // -------------------------------------------------------------- lab: config
  const POLICIES = [
    { id: 'adaptive', short: 'Adaptive (budgeted)' },
    { id: 'fixed_capped', short: 'Fixed + cap', dash: '6 4' },
    { id: 'fixed', short: 'Fixed (uncapped)', dash: '2 3' },
    { id: 'eager', short: 'Eager duplicate' },
    { id: 'none', short: 'No hedging' },
  ];
  const hidden = new Set();

  const SPECS = [
    { key: 'utilization', group: 'workload', label: 'Load (utilisation)', min: 10, max: 85, step: 1, to: (v) => v / 100, from: (c) => c * 100, fmt: (v) => v + '%', hint: 'Nominal per-server busy time.' },
    { key: 'fanout', group: 'workload', label: 'Fan-out (shards per request)', min: 1, max: 100, step: 1, to: (v) => v, from: (c) => c, fmt: (v) => v },
    { key: 'replicas', group: 'workload', label: 'Replicas per shard', min: 2, max: 5, step: 1, to: (v) => v, from: (c) => c, fmt: (v) => v },
    { key: 'slow_fraction', group: 'stragglers', label: 'Time spent slow', min: 0, max: 10, step: 0.5, to: (v) => v / 100, from: (c) => c * 100, fmt: (v) => v + '%', hint: 'Share of time a server is in a slowdown episode.' },
    { key: 'slow_factor', group: 'stragglers', label: 'Slowdown factor', min: 2, max: 40, step: 1, to: (v) => v, from: (c) => c, fmt: (v) => v + '×' },
    { key: 'correlation', group: 'stragglers', label: 'Correlation across replicas', min: 0, max: 100, step: 5, to: (v) => v / 100, from: (c) => c * 100, fmt: (v) => v + '%', hint: 'How often replicas of a shard are slow together.' },
    { key: 'surge_factor', group: 'shift', label: 'Load surge', min: 0.5, max: 2, step: 0.05, to: (v) => v, from: (c) => c, fmt: (v) => v.toFixed(2) + '×', hint: 'Arrival-rate multiplier at the shift.' },
    { key: 'degrade_factor', group: 'shift', label: 'Straggler increase', min: 1, max: 8, step: 0.5, to: (v) => v, from: (c) => c, fmt: (v) => v.toFixed(1) + '×', hint: 'Slow-time multiplier at the shift.' },
    { key: 'budget', group: 'budget', label: 'Budget ε (extra requests)', min: 1, max: 20, step: 1, to: (v) => v / 100, from: (c) => c * 100, fmt: (v) => v + '%', hint: 'Hard cap on hedges as a share of requests.' },
  ];
  const PRESETS = [
    { id: 'steady', label: 'Steady state', set: {} },
    { id: 'surge', label: 'Load surge', set: { surge_factor: 1.6 } },
    { id: 'degrade', label: 'Degrading fleet', set: { degrade_factor: 4 } },
    { id: 'both', label: 'Surge + degradation', set: { surge_factor: 1.6, degrade_factor: 3 } },
    { id: 'corr', label: 'Correlated stragglers', set: { correlation: 0.8 } },
    { id: 'wide', label: 'Wide fan-out', set: { fanout: 100, utilization: 0.4 } },
  ];

  let defaults = null;
  let cfg = null;
  let activePreset = 'surge';
  const inputs = new Map();

  function buildControls() {
    for (const sp of SPECS) {
      const id = 'ctl-' + sp.key;
      const out = h('output', { for: id });
      const inp = h('input', { type: 'range', id, min: sp.min, max: sp.max, step: sp.step });
      const field = h('div', { class: 'field' },
        h('div', { class: 'row' }, h('label', { for: id, text: sp.label }), out),
        inp,
        sp.hint ? h('div', { class: 'hint', text: sp.hint }) : null,
      );
      $('#grp-' + sp.group).append(field);
      inp.addEventListener('input', () => {
        cfg[sp.key] = sp.to(+inp.value);
        out.textContent = sp.fmt(+inp.value);
        setPreset(null);
        schedule();
      });
      inputs.set(sp.key, { inp, out, sp });
    }
    const box = $('#presets');
    for (const p of PRESETS) {
      box.append(h('button', {
        class: 'chip', type: 'button', 'data-id': p.id, 'aria-pressed': 'false', text: p.label,
        onclick: () => { applyPreset(p); run(); },
      }));
    }
    $('#seed').addEventListener('change', () => {
      cfg.seed = clamp(Math.floor(+$('#seed').value) || 0, 0, 999999);
      $('#seed').value = cfg.seed;
      run();
    });
    $('#run').addEventListener('click', run);
    $('#reroll').addEventListener('click', () => {
      cfg.seed = Math.floor(Math.random() * 1000000);
      $('#seed').value = cfg.seed;
      run();
    });
  }

  function syncInputs() {
    for (const { inp, out, sp } of inputs.values()) {
      const v = +sp.from(cfg[sp.key]).toFixed(2);
      inp.value = v;
      out.textContent = sp.fmt(v);
    }
    $('#seed').value = cfg.seed;
  }
  function setPreset(id) {
    activePreset = id;
    for (const b of document.querySelectorAll('#presets .chip')) b.setAttribute('aria-pressed', String(b.dataset.id === id));
  }
  function applyPreset(p) {
    cfg = { ...defaults, seed: cfg.seed, ...p.set };
    syncInputs();
    setPreset(p.id);
  }

  // ---------------------------------------------------------------- lab: run
  let timer = null;
  let inflight = null;
  let lastRun = null;
  const statusEl = $('#status');

  function schedule() {
    clearTimeout(timer);
    statusEl.className = 'status';
    statusEl.textContent = 'Changed. Re-running…';
    timer = setTimeout(run, 500);
  }

  async function run() {
    clearTimeout(timer);
    if (inflight) inflight.abort();
    const ctl = (inflight = new AbortController());
    const btn = $('#run');
    btn.disabled = true;
    $('#lab-root').classList.add('loading');
    statusEl.className = 'status';
    statusEl.textContent = 'Simulating five policies on identical traffic…';
    const t0 = performance.now();
    try {
      const res = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cfg),
        signal: ctl.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);
      lastRun = body;
      renderAll();
      statusEl.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s · ${body.results[0].completed.toLocaleString()} user requests measured per policy.`;
    } catch (e) {
      if (e.name === 'AbortError') return;
      statusEl.className = 'status err';
      statusEl.textContent = e.message;
    } finally {
      if (inflight === ctl) {
        inflight = null;
        btn.disabled = false;
        $('#lab-root').classList.remove('loading');
      }
    }
  }

  // ------------------------------------------------------------ lab: render
  function byId(run, id) { return run.results.find((r) => r.id === id); }

  function renderAll() {
    const r = lastRun;
    if (!r) return;
    renderLegend();
    renderCards(r);
    renderInsight(r);
    renderHero(r);
    renderCharts(r);
    renderTable(r);
  }

  function renderLegend() {
    const box = $('#legend');
    box.replaceChildren(...POLICIES.map((p) => {
      const sw = h('span', { class: 'swatch' + (p.dash ? ' dash' : '') });
      sw.style.setProperty('--c', `var(--c-${p.id})`);
      return h('button', {
        type: 'button', 'aria-pressed': String(!hidden.has(p.id)),
        onclick: () => { hidden.has(p.id) ? hidden.delete(p.id) : hidden.add(p.id); renderAll(); },
      }, sw, p.short);
    }));
  }

  function renderCards(r) {
    const none = byId(r, 'none');
    const budgetPct = r.config.budget * 100;
    $('#cards').replaceChildren(...POLICIES.filter((p) => !hidden.has(p.id)).map((p) => {
      const x = byId(r, p.id);
      const delta = (a, b) => (b > 0 ? Math.round((1 - a / b) * 100) : 0);
      const d99 = delta(x.user.p99, none.user.p99), d999 = delta(x.user.p999, none.user.p999);
      let badge;
      if (p.id === 'none') badge = h('span', { class: 'badge na', text: 'Baseline' });
      else if (x.extra_pct <= budgetPct + 0.25) badge = h('span', { class: 'badge ok', text: `✓ Within ${budgetPct.toFixed(0)}% budget` });
      else badge = h('span', { class: 'badge over', text: `✕ ${(x.extra_pct / budgetPct).toFixed(1)}× over budget` });
      const sw = h('span', { class: 'swatch' + (p.dash ? ' dash' : '') });
      sw.style.setProperty('--c', `var(--c-${p.id})`);
      const card = h('div', { class: 'card pcard' + (p.id === 'adaptive' ? ' hero-card' : '') },
        h('h4', {}, sw, p.short),
        h('dl', {},
          h('dt', { text: 'p99' }), h('dd', {}, fmtMs(x.user.p99), p.id !== 'none' && d99 ? h('div', { class: 'delta', text: (d99 > 0 ? '−' : '+') + Math.abs(d99) + '%' }) : null),
          h('dt', { text: 'p99.9' }), h('dd', {}, fmtMs(x.user.p999), p.id !== 'none' && d999 ? h('div', { class: 'delta', text: (d999 > 0 ? '−' : '+') + Math.abs(d999) + '%' }) : null),
          h('dt', { text: 'Extra requests' }), h('dd', { text: fmtPct(x.extra_pct) }),
          h('dt', { text: 'Wasted work' }), h('dd', { text: fmtPct(x.wasted_pct) }),
        ),
        badge,
      );
      card.style.setProperty('--c', `var(--c-${p.id})`);
      return card;
    }));
  }

  function renderInsight(r) {
    const a = byId(r, 'adaptive'), fc = byId(r, 'fixed_capped'), f = byId(r, 'fixed'), none = byId(r, 'none'), e = byId(r, 'eager');
    const eps = r.config.budget * 100;
    const lines = [];
    const ratio = fc.user.p999 / a.user.p999;
    const verdict = ratio >= 1.1 ? `<b>${ratio.toFixed(1)}× lower</b>` : ratio <= 0.9 ? `<b>${(1 / ratio).toFixed(1)}× higher</b>` : '<b>about the same</b>';
    lines.push(`At the same ${eps.toFixed(0)}% hard budget, adaptive hedging's p99.9 is ${verdict} than a fixed delay (${fmtMs(a.user.p999)} vs ${fmtMs(fc.user.p999)}), using ${fmtPct(a.extra_pct)} extra requests.`);
    if (f.extra_pct > eps * 1.2) {
      lines.push(`The <b>uncapped</b> fixed delay spent <b>${f.extra_pct.toFixed(1)}%</b> extra requests, ${(f.extra_pct / eps).toFixed(1)}× its design budget${f.user.p999 < a.user.p999 ? ', which buys lower latency here but is the overload risk the cap exists to prevent' : ''}.`);
    }
    if (e.util_pct != null && e.utilization_pct > none.utilization_pct + 10) {
      lines.push(`Eager duplication doubles traffic (server utilisation ${none.utilization_pct.toFixed(0)}% → ${e.utilization_pct.toFixed(0)}%).`);
    }
    if (r.config.correlation >= 0.5) lines.push('With correlated stragglers, replicas are often slow together, so hedging has little to escape to.');
    const box = $('#insight');
    box.replaceChildren(h('span', { class: 'tag', text: 'Reading the results' }));
    for (const l of lines) { const p = h('p'); p.innerHTML = l; box.append(p); }
  }

  function renderHero(r) {
    const a = byId(r, 'adaptive'), none = byId(r, 'none');
    const cut = none.user.p999 > 0 ? Math.round((1 - a.user.p999 / none.user.p999) * 100) : 0;
    $('#hs-tail').textContent = (cut >= 0 ? '−' : '+') + Math.abs(cut) + '%';
    $('#hs-extra').textContent = fmtPct(a.extra_pct);
  }

  function renderCharts(r) {
    const tick = [[0.3, 'p50'], [1, 'p90'], [2, 'p99'], [3, 'p99.9'], [4, 'p99.99']];
    const kmax = Math.max(1, ...r.results.map((x) => (x.spectrum.length ? x.spectrum[x.spectrum.length - 1][0] : 1)));
    const label = (p) => p.short;
    const pct = (k) => (k < 3 ? (100 - Math.pow(10, 2 - k)).toFixed(k < 1.5 ? 0 : 1) : (100 - Math.pow(10, 2 - k)).toFixed(2));
    chart('ch-spectrum', {
      series: POLICIES.map((p) => ({ id: p.id, label: label(p), dash: p.dash, pts: byId(r, p.id).spectrum })),
      xDomain: [0.3, kmax], xTicks: tick, yLog: true, height: 320,
      fmtY: (v) => (v >= 1000 ? v / 1000 + 's' : v + 'ms'), fmtTip: fmtMs,
      xTitle: 'percentile of user requests', yTitle: 'latency (log scale)',
      tipTitle: (k) => `p${pct(k)}`,
    });

    const shift = r.shift_time_s, warm = r.config.warmup_s;
    const dur = r.config.duration_s;
    const timeline = (key) => (p) => ({ ...p });
    const mkSeries = (field, ids) => ids.map((id) => {
      const p = POLICIES.find((q) => q.id === id);
      return { id, label: label(p), dash: p.dash, pts: byId(r, id).timeline.map((t) => [t.t, t[field]]) };
    });
    const bands = [{ x0: 0, x1: warm, label: 'warm-up' }];
    const markers = (r.config.surge_factor !== 1 || r.config.degrade_factor !== 1) ? [{ x: shift, label: 'regime shift' }] : [];
    const xt = Array.from({ length: Math.floor(dur / 10) + 1 }, (_, i) => [i * 10, i * 10 + 's']);
    const common = { xDomain: [0, dur], xTicks: xt, bands, markers, tipTitle: (t) => `t = ${t.toFixed(1)} s` };

    chart('ch-time', { ...common, series: mkSeries('p99', POLICIES.map((p) => p.id)), yLog: true, height: 300, fmtY: (v) => (v >= 1000 ? v / 1000 + 's' : v + 'ms'), fmtTip: fmtMs, yTitle: 'p99 latency (log)' });
    chart('ch-extra', {
      ...common,
      series: mkSeries('extra_pct', ['adaptive', 'fixed_capped', 'fixed']), yLog: false, yMin: 0, height: 250,
      fmtY: (v) => v + '%', fmtTip: (v) => v.toFixed(1) + '%', yTitle: 'extra requests',
      refLines: [{ y: r.config.budget * 100, label: `budget ε = ${(r.config.budget * 100).toFixed(0)}%` }],
    });
    chart('ch-delay', {
      ...common,
      series: mkSeries('delay_ms', ['adaptive', 'fixed']), yLog: false, yMin: 0, height: 250,
      fmtY: (v) => v + 'ms', fmtTip: fmtMs, yTitle: 'delay before hedging',
    });
  }

  function renderTable(r) {
    const t = $('#tbl');
    const head = h('tr', {}, ...['Policy', 'p50', 'p99', 'p99.9', 'Extra req.', 'Wasted work', 'Utilisation', 'Hedges denied'].map((x) => h('th', { text: x })));
    const rows = POLICIES.map((p) => {
      const x = byId(r, p.id);
      return h('tr', {}, h('td', { text: p.short }), h('td', { text: fmtMs(x.user.p50) }), h('td', { text: fmtMs(x.user.p99) }), h('td', { text: fmtMs(x.user.p999) }),
        h('td', { text: fmtPct(x.extra_pct) }), h('td', { text: fmtPct(x.wasted_pct) }), h('td', { text: fmtPct(x.utilization_pct, 0) }), h('td', { text: x.hedges_denied.toLocaleString() }));
    });
    t.replaceChildren(h('thead', {}, head), h('tbody', {}, ...rows));
  }

  // -------------------------------------------------------------------- boot
  async function boot() {
    renderCalc();
    try {
      const res = await fetch('/api/defaults');
      defaults = await res.json();
    } catch {
      statusEl.className = 'status err';
      statusEl.textContent = 'Could not reach the simulator API. Is `hedgeq serve` running?';
      return;
    }
    cfg = { ...defaults };
    buildControls();
    applyPreset(PRESETS.find((p) => p.id === 'surge'));
    run();
  }
  boot();
})();
