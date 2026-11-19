//! Deterministic discrete-event simulator of a replicated fan-out service.
//!
//! Model
//! -----
//! * `fanout` shards, each stored on `replicas` servers. Every user request is
//!   split into one sub-request per shard and finishes when the *slowest*
//!   sub-request does.
//! * Each server is a single FIFO queue with log-normal service times.
//! * Servers suffer transient slowdown episodes (noisy neighbour, GC, compaction):
//!   during an episode service times are multiplied by `slow_factor`. With
//!   probability `correlation` a server follows its shard's shared episode
//!   schedule instead of its own, so replicas can be slow *together*.
//! * Optional regime shifts halfway through the run: an arrival-rate surge and/or
//!   a higher straggler rate.
//! * Cancellation is cooperative and immediate: when a sub-request completes,
//!   its other copy is dequeued, or pre-empted if already running (the work done
//!   so far is counted as waste).
//!
//! All per-request randomness is keyed, not sequential, so every policy faces
//! identical arrivals, identical work and identical slowdown episodes.

use crate::policy::{Policy, PolicyKind};
use crate::rng::{normal, unit, Rng};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BinaryHeap, VecDeque};

const NONE: u32 = u32::MAX;
const TICK_S: f64 = 0.1;
/// Upper bound on sub-requests per run (memory guard).
const MAX_SUBREQUESTS: f64 = 1_500_000.0;
/// Approximate number of individual requests returned per policy for plotting.
const TARGET_SAMPLES: f64 = 1200.0;
/// Approximate number of fully traced requests (per-shard timings) per policy.
const TARGET_TRACES: f64 = 150.0;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SimConfig {
    pub seed: u64,
    pub duration_s: f64,
    pub warmup_s: f64,
    pub fanout: u32,
    pub replicas: u32,
    /// Nominal per-server utilisation before the surge and ignoring slowdowns.
    pub utilization: f64,
    pub service_median_ms: f64,
    pub service_sigma: f64,
    /// Long-run fraction of time a server spends in a slowdown episode.
    pub slow_fraction: f64,
    pub slow_factor: f64,
    pub episode_ms: f64,
    /// Probability a replica shares its shard's episode schedule.
    pub correlation: f64,
    /// Arrival-rate multiplier applied at the midpoint of the run.
    pub surge_factor: f64,
    /// Straggler-rate multiplier applied at the midpoint of the run.
    pub degrade_factor: f64,
    /// Hedge budget epsilon: target fraction of extra requests.
    pub budget: f64,
    /// Token-bucket capacity for the adaptive policy.
    pub burst: f64,
}

impl Default for SimConfig {
    fn default() -> Self {
        SimConfig {
            seed: 1,
            duration_s: 60.0,
            warmup_s: 6.0,
            fanout: 20,
            replicas: 3,
            utilization: 0.45,
            service_median_ms: 5.0,
            service_sigma: 0.35,
            slow_fraction: 0.02,
            slow_factor: 12.0,
            episode_ms: 120.0,
            correlation: 0.0,
            surge_factor: 1.0,
            degrade_factor: 1.0,
            budget: 0.05,
            burst: 400.0,
        }
    }
}

impl SimConfig {
    pub fn mean_service_s(&self) -> f64 {
        self.service_median_ms / 1000.0 * (self.service_sigma * self.service_sigma / 2.0).exp()
    }

    /// Base user-request arrival rate (requests/second).
    pub fn base_rate(&self) -> f64 {
        self.utilization * self.replicas as f64 / self.mean_service_s()
    }

    pub fn shift_time_s(&self) -> f64 {
        self.duration_s / 2.0
    }

    pub fn validate(&self) -> Result<(), String> {
        fn range(name: &str, v: f64, lo: f64, hi: f64) -> Result<(), String> {
            if v.is_finite() && v >= lo && v <= hi {
                Ok(())
            } else {
                Err(format!("{name} must be between {lo} and {hi}"))
            }
        }
        range("duration_s", self.duration_s, 10.0, 180.0)?;
        range("warmup_s", self.warmup_s, 1.0, self.duration_s / 2.0)?;
        range("fanout", self.fanout as f64, 1.0, 200.0)?;
        range("replicas", self.replicas as f64, 2.0, 5.0)?;
        range("utilization", self.utilization, 0.05, 0.9)?;
        range("service_median_ms", self.service_median_ms, 0.1, 100.0)?;
        range("service_sigma", self.service_sigma, 0.0, 1.5)?;
        range("slow_fraction", self.slow_fraction, 0.0, 0.3)?;
        range("slow_factor", self.slow_factor, 1.0, 100.0)?;
        range("episode_ms", self.episode_ms, 5.0, 5000.0)?;
        range("correlation", self.correlation, 0.0, 1.0)?;
        range("surge_factor", self.surge_factor, 0.2, 3.0)?;
        range("degrade_factor", self.degrade_factor, 1.0, 10.0)?;
        range("budget", self.budget, 0.001, 0.5)?;
        range("burst", self.burst, 1.0, 10000.0)?;
        if self.utilization * self.surge_factor.max(1.0) > 0.95 {
            return Err("utilization x surge_factor must not exceed 0.95".into());
        }
        if self.slow_fraction * self.degrade_factor > 0.5 {
            return Err("slow_fraction x degrade_factor must not exceed 0.5".into());
        }
        let expected = self.base_rate() * self.surge_factor.max(1.0) * self.duration_s * self.fanout as f64;
        if expected > MAX_SUBREQUESTS {
            return Err(format!(
                "this configuration would simulate ~{:.0} sub-requests; the limit is {:.0}. Reduce fanout, load or duration.",
                expected, MAX_SUBREQUESTS
            ));
        }
        Ok(())
    }
}

// ----------------------------------------------------------------------------
// Results
// ----------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
pub struct Percentiles {
    pub mean: f64,
    pub p50: f64,
    pub p90: f64,
    pub p99: f64,
    pub p999: f64,
    pub max: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct TimelinePoint {
    pub t: f64,
    pub p50: Option<f64>,
    pub p99: Option<f64>,
    pub delay_ms: Option<f64>,
    pub extra_pct: f64,
    pub warmup: bool,
}

/// One user request broken down by shard, for replaying what a page load looks like.
#[derive(Clone, Debug, Serialize)]
pub struct Trace {
    pub arrival_s: f64,
    /// Per shard: `[latency_ms, 1 if the hedge copy won else 0]`.
    pub shards: Vec<[f64; 2]>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PolicyResult {
    pub id: &'static str,
    pub label: &'static str,
    pub user: Percentiles,
    pub sub: Percentiles,
    pub completed: usize,
    pub primaries: u64,
    pub hedges_sent: u64,
    pub hedges_denied: u64,
    /// Hedges sent as a percentage of primaries (extra requests).
    pub extra_pct: f64,
    /// Server time spent on copies that lost the race, as a percentage of all busy time.
    pub wasted_pct: f64,
    pub utilization_pct: f64,
    /// `[ -log10(1-p), latency_ms ]` points of the user-latency percentile spectrum.
    pub spectrum: Vec<[f64; 2]>,
    pub timeline: Vec<TimelinePoint>,
    /// Evenly thinned user requests, identical across policies: `[arrival_s, latency_ms, hedged (0/1)]`.
    pub samples: Vec<[f64; 3]>,
    /// Fully traced requests, identical across policies.
    pub traces: Vec<Trace>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Comparison {
    pub config: SimConfig,
    pub shift_time_s: f64,
    pub base_rate_rps: f64,
    pub results: Vec<PolicyResult>,
}

// ----------------------------------------------------------------------------
// Slowdown schedules
// ----------------------------------------------------------------------------

struct Schedule {
    starts: Vec<f64>,
    ends: Vec<f64>,
}

impl Schedule {
    fn generate(cfg: &SimConfig, rng: &mut Rng, horizon: f64) -> Schedule {
        let mut s = Schedule { starts: vec![], ends: vec![] };
        if cfg.slow_fraction <= 0.0 {
            return s;
        }
        let dur_mean = cfg.episode_ms / 1000.0;
        let shift = cfg.shift_time_s();
        let frac_at = |t: f64| (cfg.slow_fraction * if t >= shift { cfg.degrade_factor } else { 1.0 }).min(0.5);
        let mut t = 0.0;
        while t < horizon {
            let f = frac_at(t);
            let gap = rng.exp(dur_mean * (1.0 - f) / f);
            // Memorylessness lets us restart the gap at the regime boundary.
            if t < shift && t + gap > shift && cfg.degrade_factor != 1.0 {
                t = shift;
                continue;
            }
            let start = t + gap;
            let end = start + rng.exp(dur_mean);
            s.starts.push(start);
            s.ends.push(end);
            t = end;
        }
        s
    }

    #[inline]
    fn factor(&self, t: f64, slow: f64) -> f64 {
        let i = self.starts.partition_point(|&s| s <= t);
        if i > 0 && t < self.ends[i - 1] {
            slow
        } else {
            1.0
        }
    }
}

// ----------------------------------------------------------------------------
// Simulator
// ----------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum CopyState {
    Queued,
    Running,
    Done,
    Cancelled,
}

struct Copy {
    sub: u32,
    server: u32,
    start: f64,
    state: CopyState,
}

struct Sub {
    req: u32,
    issue: f64,
    primary: u32,
    hedge: u32,
    shard: u16,
    replica: u8,
    done: bool,
}

struct Req {
    arrival: f64,
    remaining: u32,
    hedged: bool,
}

struct Server {
    queue: VecDeque<u32>,
    running: u32,
    busy: f64,
    sched: usize,
}

#[derive(Clone, Copy)]
enum Ev {
    Arrival,
    Done { server: u32, copy: u32 },
    Hedge { sub: u32 },
    Tick,
}

struct Event {
    t: f64,
    seq: u64,
    ev: Ev,
}

impl PartialEq for Event {
    fn eq(&self, o: &Self) -> bool {
        self.t == o.t && self.seq == o.seq
    }
}
impl Eq for Event {}
impl PartialOrd for Event {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Event {
    // Reversed so BinaryHeap pops the earliest event first.
    fn cmp(&self, o: &Self) -> Ordering {
        o.t.total_cmp(&self.t).then(o.seq.cmp(&self.seq))
    }
}

#[derive(Default, Clone)]
struct Bucket {
    lat: Vec<f32>,
    primaries: u32,
    hedges: u32,
    delay_ms: Option<f64>,
}

struct Sim<'a> {
    cfg: &'a SimConfig,
    policy: Policy,
    heap: BinaryHeap<Event>,
    seq: u64,
    arrivals: Rng,
    servers: Vec<Server>,
    schedules: Vec<Schedule>,
    reqs: Vec<Req>,
    subs: Vec<Sub>,
    copies: Vec<Copy>,
    base_rate: f64,
    warmed_up: bool,
    // statistics
    user_lat: Vec<f64>,
    sub_lat: Vec<f64>,
    samples: Vec<[f64; 3]>,
    sample_stride: u32,
    trace_stride: u32,
    trace_parts: BTreeMap<u32, Vec<[f64; 2]>>,
    buckets: Vec<Bucket>,
    primaries: u64,
    hedges_sent: u64,
    hedges_denied: u64,
    wasted: f64,
    end_time: f64,
}

pub fn run(cfg: &SimConfig, kind: PolicyKind) -> PolicyResult {
    let mut sim = Sim::new(cfg, kind);
    sim.execute();
    sim.finish()
}

/// Run every policy on the same seed, in parallel.
pub fn run_all(cfg: &SimConfig) -> Comparison {
    let mut results: Vec<PolicyResult> = std::thread::scope(|s| {
        let handles: Vec<_> = PolicyKind::ALL.iter().map(|&k| s.spawn(move || run(cfg, k))).collect();
        handles.into_iter().map(|h| h.join().expect("simulation thread panicked")).collect()
    });
    results.sort_by_key(|r| PolicyKind::ALL.iter().position(|k| k.id() == r.id));
    Comparison { config: cfg.clone(), shift_time_s: cfg.shift_time_s(), base_rate_rps: cfg.base_rate(), results }
}

impl<'a> Sim<'a> {
    fn new(cfg: &'a SimConfig, kind: PolicyKind) -> Self {
        let shards = cfg.fanout as usize;
        let replicas = cfg.replicas as usize;
        let horizon = cfg.duration_s + 5.0;

        let mut schedules = Vec::with_capacity(shards + shards * replicas);
        for i in 0..(shards + shards * replicas) {
            let mut rng = Rng::new(cfg.seed.wrapping_mul(0x1000_0001).wrapping_add(i as u64 + 1));
            schedules.push(Schedule::generate(cfg, &mut rng, horizon));
        }
        let servers = (0..shards * replicas)
            .map(|id| {
                let shard = id / replicas;
                let shared = unit(cfg.seed, id as u64, 77) < cfg.correlation;
                Server { queue: VecDeque::new(), running: NONE, busy: 0.0, sched: if shared { shard } else { shards + id } }
            })
            .collect();

        let n_buckets = cfg.duration_s.ceil() as usize + 2;
        Sim {
            cfg,
            policy: Policy::new(kind, cfg.budget, cfg.burst),
            heap: BinaryHeap::new(),
            seq: 0,
            arrivals: Rng::new(cfg.seed ^ 0xA77_1CA1),
            servers,
            schedules,
            reqs: Vec::new(),
            subs: Vec::new(),
            copies: Vec::new(),
            base_rate: cfg.base_rate(),
            warmed_up: false,
            user_lat: Vec::new(),
            sub_lat: Vec::new(),
            samples: Vec::new(),
            sample_stride: {
                let expected = cfg.base_rate() * (0.5 + 0.5 * cfg.surge_factor) * cfg.duration_s;
                ((expected / TARGET_SAMPLES).ceil() as u32).max(1)
            },
            trace_stride: {
                let expected = cfg.base_rate() * (0.5 + 0.5 * cfg.surge_factor) * cfg.duration_s;
                ((expected / TARGET_TRACES).ceil() as u32).max(1)
            },
            trace_parts: BTreeMap::new(),
            buckets: vec![Bucket::default(); n_buckets],
            primaries: 0,
            hedges_sent: 0,
            hedges_denied: 0,
            wasted: 0.0,
            end_time: 0.0,
        }
    }

    fn push(&mut self, t: f64, ev: Ev) {
        self.seq += 1;
        self.heap.push(Event { t, seq: self.seq, ev });
    }

    fn rate_at(&self, t: f64) -> f64 {
        if t >= self.cfg.shift_time_s() {
            self.base_rate * self.cfg.surge_factor
        } else {
            self.base_rate
        }
    }

    fn schedule_next_arrival(&mut self, now: f64) {
        let shift = self.cfg.shift_time_s();
        let mut next = now + self.arrivals.exp(1.0) / self.rate_at(now);
        if now < shift && next > shift && self.cfg.surge_factor != 1.0 {
            next = shift + self.arrivals.exp(1.0) / self.rate_at(shift);
        }
        if next < self.cfg.duration_s {
            self.push(next, Ev::Arrival);
        }
    }

    fn execute(&mut self) {
        self.schedule_next_arrival(0.0);
        self.push(TICK_S, Ev::Tick);
        while let Some(Event { t: now, ev, .. }) = self.heap.pop() {
            self.end_time = now;
            match ev {
                Ev::Arrival => self.on_arrival(now),
                Ev::Done { server, copy } => self.on_done(now, server as usize, copy),
                Ev::Hedge { sub } => self.on_hedge(now, sub),
                Ev::Tick => self.on_tick(now),
            }
        }
    }

    fn on_tick(&mut self, now: f64) {
        if !self.warmed_up && now >= self.cfg.warmup_s {
            self.warmed_up = true;
            self.policy.end_warmup();
        }
        self.policy.tick(TICK_S);
        let b = (now as usize).min(self.buckets.len() - 1);
        self.buckets[b].delay_ms = self.policy.delay_ms();
        if now + TICK_S < self.cfg.duration_s {
            self.push(now + TICK_S, Ev::Tick);
        }
    }

    fn on_arrival(&mut self, now: f64) {
        let req = self.reqs.len() as u32;
        self.reqs.push(Req { arrival: now, remaining: self.cfg.fanout, hedged: false });
        for shard in 0..self.cfg.fanout {
            self.issue_sub(now, req, shard);
        }
        self.schedule_next_arrival(now);
    }

    fn issue_sub(&mut self, now: f64, req: u32, shard: u32) {
        let sub_id = self.subs.len() as u32;
        let key = req as u64 * self.cfg.fanout as u64 + shard as u64;
        let replica = (unit(self.cfg.seed, key, 5) * self.cfg.replicas as f64) as u8;
        let server = shard * self.cfg.replicas + replica as u32;
        let copy = self.new_copy(sub_id, server);
        self.subs.push(Sub { req, issue: now, primary: copy, hedge: NONE, shard: shard as u16, replica, done: false });
        self.primaries += 1;
        let b = (now as usize).min(self.buckets.len() - 1);
        self.buckets[b].primaries += 1;
        self.policy.on_primary();
        if let Some(d) = self.policy.delay_ms() {
            self.push(now + d / 1000.0, Ev::Hedge { sub: sub_id });
        }
        self.enqueue(now, copy);
    }

    fn new_copy(&mut self, sub: u32, server: u32) -> u32 {
        self.copies.push(Copy { sub, server, start: 0.0, state: CopyState::Queued });
        (self.copies.len() - 1) as u32
    }

    fn enqueue(&mut self, now: f64, copy: u32) {
        let s = self.copies[copy as usize].server as usize;
        if self.servers[s].running == NONE {
            self.start(now, s, copy);
        } else {
            self.servers[s].queue.push_back(copy);
        }
    }

    fn start(&mut self, now: f64, s: usize, copy: u32) {
        let sub = self.copies[copy as usize].sub;
        let idx = if self.subs[sub as usize].primary == copy { 0 } else { 1 };
        let key = sub as u64 * 2 + idx;
        let z = normal(unit(self.cfg.seed, key, 1001), unit(self.cfg.seed, key, 1002));
        let base = self.cfg.service_median_ms / 1000.0 * (self.cfg.service_sigma * z).exp();
        let slow = self.schedules[self.servers[s].sched].factor(now, self.cfg.slow_factor);
        let c = &mut self.copies[copy as usize];
        c.state = CopyState::Running;
        c.start = now;
        self.servers[s].running = copy;
        self.push(now + base * slow, Ev::Done { server: s as u32, copy });
    }

    fn dispatch(&mut self, now: f64, s: usize) {
        while let Some(c) = self.servers[s].queue.pop_front() {
            if self.copies[c as usize].state == CopyState::Queued {
                self.start(now, s, c);
                return;
            }
        }
    }

    fn on_hedge(&mut self, now: f64, sub_id: u32) {
        let sub = &self.subs[sub_id as usize];
        if sub.done || sub.hedge != NONE {
            return;
        }
        if !self.policy.allow_hedge() {
            self.hedges_denied += 1;
            return;
        }
        let (shard, primary_replica, issue) = (sub.shard as u32, sub.replica as u32, sub.issue);
        let r = self.cfg.replicas;
        let key = self.subs[sub_id as usize].req as u64 * self.cfg.fanout as u64 + shard as u64;
        let offset = 1 + (unit(self.cfg.seed, key, 6) * (r - 1) as f64) as u32;
        let replica = (primary_replica + offset.min(r - 1)) % r;
        let server = shard * r + replica;
        let copy = self.new_copy(sub_id, server);
        self.subs[sub_id as usize].hedge = copy;
        let req = self.subs[sub_id as usize].req;
        self.reqs[req as usize].hedged = true;
        self.hedges_sent += 1;
        let b = (issue as usize).min(self.buckets.len() - 1);
        self.buckets[b].hedges += 1;
        self.enqueue(now, copy);
    }

    fn cancel(&mut self, now: f64, copy: u32) {
        let c = &self.copies[copy as usize];
        match c.state {
            CopyState::Queued => self.copies[copy as usize].state = CopyState::Cancelled,
            CopyState::Running => {
                let s = c.server as usize;
                let spent = now - c.start;
                self.servers[s].busy += spent;
                self.wasted += spent;
                self.servers[s].running = NONE;
                self.copies[copy as usize].state = CopyState::Cancelled;
                self.dispatch(now, s);
            }
            CopyState::Done | CopyState::Cancelled => {}
        }
    }

    fn on_done(&mut self, now: f64, s: usize, copy: u32) {
        // Stale completion of a copy that was pre-empted.
        if self.servers[s].running != copy || self.copies[copy as usize].state != CopyState::Running {
            return;
        }
        let spent = now - self.copies[copy as usize].start;
        self.servers[s].busy += spent;
        self.servers[s].running = NONE;
        self.copies[copy as usize].state = CopyState::Done;
        let sub_id = self.copies[copy as usize].sub;
        self.dispatch(now, s);

        if self.subs[sub_id as usize].done {
            return;
        }
        let (issue, req, primary, hedge) = {
            let sub = &mut self.subs[sub_id as usize];
            sub.done = true;
            (sub.issue, sub.req, sub.primary, sub.hedge)
        };
        let lat_ms = (now - issue) * 1000.0;
        self.policy.observe(lat_ms);
        if issue >= self.cfg.warmup_s {
            self.sub_lat.push(lat_ms);
        }
        if req % self.trace_stride == 0 && issue >= self.cfg.warmup_s {
            let shard = self.subs[sub_id as usize].shard as usize;
            let fanout = self.cfg.fanout as usize;
            let parts = self.trace_parts.entry(req).or_insert_with(|| vec![[f64::NAN, 0.0]; fanout]);
            parts[shard] = [round(lat_ms, 1), if copy == hedge { 1.0 } else { 0.0 }];
        }
        for c in [primary, hedge] {
            if c != NONE && c != copy {
                self.cancel(now, c);
            }
        }
        let r = &mut self.reqs[req as usize];
        r.remaining -= 1;
        if r.remaining == 0 {
            let arrival = r.arrival;
            let lat = (now - arrival) * 1000.0;
            if arrival >= self.cfg.warmup_s {
                self.user_lat.push(lat);
                if req % self.sample_stride == 0 {
                    let hedged = if self.reqs[req as usize].hedged { 1.0 } else { 0.0 };
                    self.samples.push([round(arrival, 3), round(lat, 2), hedged]);
                }
            }
            let b = (arrival as usize).min(self.buckets.len() - 1);
            self.buckets[b].lat.push(lat as f32);
        }
    }

    fn finish(mut self) -> PolicyResult {
        let kind = self.policy.kind();
        let warm = self.cfg.warmup_s;
        let user = summarize(&mut self.user_lat);
        let sub = summarize(&mut self.sub_lat);
        let completed = self.user_lat.len();

        // Percentile spectrum on a "number of nines" axis, up to where we have >= 5 samples.
        let mut spectrum = Vec::new();
        if completed >= 20 {
            let kmax = (completed as f64 / 5.0).log10().min(4.5);
            let mut k = 0.3;
            while k <= kmax + 1e-9 {
                let p = 1.0 - 10f64.powf(-k);
                spectrum.push([round(k, 3), round(quantile_sorted(&self.user_lat, p), 3)]);
                k += 0.05;
            }
        }

        // Timeline, p50/p99 over a centred 3-second window to reduce noise.
        let n = self.cfg.duration_s.ceil() as usize;
        let mut timeline = Vec::with_capacity(n);
        for i in 0..n {
            let lo = i.saturating_sub(1);
            let hi = (i + 1).min(self.buckets.len() - 1);
            let mut window: Vec<f64> = Vec::new();
            for b in &self.buckets[lo..=hi] {
                window.extend(b.lat.iter().map(|&x| x as f64));
            }
            window.sort_by(|a, b| a.total_cmp(b));
            let (p50, p99) = if window.len() >= 30 {
                (Some(round(quantile_sorted(&window, 0.5), 3)), Some(round(quantile_sorted(&window, 0.99), 3)))
            } else {
                (None, None)
            };
            let b = &self.buckets[i];
            timeline.push(TimelinePoint {
                t: i as f64 + 0.5,
                p50,
                p99,
                delay_ms: b.delay_ms.map(|d| round(d, 3)),
                extra_pct: if b.primaries > 0 { round(100.0 * b.hedges as f64 / b.primaries as f64, 3) } else { 0.0 },
                warmup: (i as f64 + 1.0) <= warm,
            });
        }

        let traces: Vec<Trace> = std::mem::take(&mut self.trace_parts)
            .into_iter()
            .filter(|(_, v)| v.iter().all(|x| x[0].is_finite()))
            .map(|(req, shards)| Trace { arrival_s: round(self.reqs[req as usize].arrival, 3), shards })
            .collect();
        let busy: f64 = self.servers.iter().map(|s| s.busy).sum();
        let capacity = self.servers.len() as f64 * self.end_time.max(1e-9);
        PolicyResult {
            id: kind.id(),
            label: kind.label(),
            user,
            sub,
            completed,
            primaries: self.primaries,
            hedges_sent: self.hedges_sent,
            hedges_denied: self.hedges_denied,
            extra_pct: round(100.0 * self.hedges_sent as f64 / self.primaries.max(1) as f64, 3),
            wasted_pct: round(100.0 * self.wasted / busy.max(1e-12), 3),
            utilization_pct: round(100.0 * busy / capacity, 2),
            spectrum,
            timeline,
            samples: self.samples,
            traces,
        }
    }
}

fn round(x: f64, places: i32) -> f64 {
    let m = 10f64.powi(places);
    (x * m).round() / m
}

/// Nearest-rank quantile of an already sorted slice.
fn quantile_sorted(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let idx = ((p * sorted.len() as f64).ceil() as usize).clamp(1, sorted.len()) - 1;
    sorted[idx]
}

fn summarize(v: &mut [f64]) -> Percentiles {
    v.sort_by(|a, b| a.total_cmp(b));
    if v.is_empty() {
        return Percentiles { mean: 0.0, p50: 0.0, p90: 0.0, p99: 0.0, p999: 0.0, max: 0.0 };
    }
    let mean = v.iter().sum::<f64>() / v.len() as f64;
    Percentiles {
        mean: round(mean, 3),
        p50: round(quantile_sorted(v, 0.5), 3),
        p90: round(quantile_sorted(v, 0.9), 3),
        p99: round(quantile_sorted(v, 0.99), 3),
        p999: round(quantile_sorted(v, 0.999), 3),
        max: round(*v.last().unwrap(), 3),
    }
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;

    fn quick() -> SimConfig {
        SimConfig { duration_s: 30.0, warmup_s: 4.0, fanout: 12, ..SimConfig::default() }
    }

    #[test]
    fn default_config_is_valid() {
        SimConfig::default().validate().unwrap();
    }

    #[test]
    fn validation_rejects_bad_input() {
        let mut c = SimConfig::default();
        c.fanout = 0;
        assert!(c.validate().is_err());
        let mut c = SimConfig::default();
        c.utilization = 0.9;
        c.surge_factor = 2.0;
        assert!(c.validate().is_err());
        let mut c = SimConfig::default();
        c.budget = f64::NAN;
        assert!(c.validate().is_err());
        let mut c = SimConfig::default();
        c.fanout = 200;
        c.duration_s = 180.0;
        assert!(c.validate().is_err(), "memory guard must trigger");
    }

    #[test]
    fn runs_are_deterministic() {
        let a = run(&quick(), PolicyKind::Adaptive);
        let b = run(&quick(), PolicyKind::Adaptive);
        assert_eq!(a.user.p99, b.user.p99);
        assert_eq!(a.hedges_sent, b.hedges_sent);
    }

    #[test]
    fn policies_share_identical_arrivals() {
        let c = quick();
        let none = run(&c, PolicyKind::None);
        let adaptive = run(&c, PolicyKind::Adaptive);
        assert_eq!(none.primaries, adaptive.primaries);
        assert_eq!(none.completed, adaptive.completed);
    }

    #[test]
    fn traces_are_paired_across_policies_and_complete() {
        let c = quick();
        let none = run(&c, PolicyKind::None);
        let adaptive = run(&c, PolicyKind::Adaptive);
        assert!(none.traces.len() >= 20, "got {} traces", none.traces.len());
        assert_eq!(none.traces.len(), adaptive.traces.len());
        for (a, b) in none.traces.iter().zip(&adaptive.traces) {
            assert_eq!(a.arrival_s, b.arrival_s);
            assert_eq!(a.shards.len(), c.fanout as usize);
        }
        assert!(none.traces.iter().all(|t| t.shards.iter().all(|s| s[1] == 0.0)), "no hedges without hedging");
    }

    #[test]
    fn no_hedging_sends_nothing_and_eager_duplicates_everything() {
        let c = quick();
        assert_eq!(run(&c, PolicyKind::None).hedges_sent, 0);
        let e = run(&c, PolicyKind::Eager);
        assert!(e.extra_pct > 95.0, "eager extra {}", e.extra_pct);
    }

    #[test]
    fn adaptive_respects_its_budget_even_under_a_surge() {
        let mut c = quick();
        c.surge_factor = 1.8;
        c.degrade_factor = 3.0;
        let r = run(&c, PolicyKind::Adaptive);
        let bound = c.budget * r.primaries as f64 + c.burst;
        assert!(r.hedges_sent as f64 <= bound, "sent {} > bound {}", r.hedges_sent, bound);
    }

    #[test]
    fn adaptive_hedging_cuts_the_far_tail() {
        let c = quick();
        let none = run(&c, PolicyKind::None);
        let adaptive = run(&c, PolicyKind::Adaptive);
        assert!(
            adaptive.user.p999 < none.user.p999 * 0.8,
            "p99.9 none {} adaptive {}",
            none.user.p999,
            adaptive.user.p999
        );
        assert!(adaptive.extra_pct <= c.budget * 100.0 + 0.5);
    }

    #[test]
    fn fully_correlated_stragglers_defeat_hedging() {
        let mut c = quick();
        c.correlation = 1.0;
        let none = run(&c, PolicyKind::None);
        let adaptive = run(&c, PolicyKind::Adaptive);
        // Hedging cannot escape a slowdown shared by all replicas.
        assert!(adaptive.user.p999 > none.user.p999 * 0.7, "none {} adaptive {}", none.user.p999, adaptive.user.p999);
    }
}
