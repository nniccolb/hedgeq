//! Hedging policies.
//!
//! A *hedge* is a duplicate of a still-outstanding request sent to a different
//! replica; the first response wins and the loser is cancelled. All policies
//! answer two questions: **when** to hedge (`delay_ms`) and **whether** a hedge
//! may be sent right now (`allow_hedge`).
//!
//! | policy     | delay                                   | load guarantee            |
//! |------------|-----------------------------------------|---------------------------|
//! | `None`     | never hedge                             | exactly 1x                |
//! | `Eager`    | 0 ms (always duplicate)                 | none (up to 2x)           |
//! | `Fixed`    | `q_(1-eps)` of warm-up latencies, frozen| none (drifts with load)   |
//! | `FixedCapped` | same frozen delay, plus the token-bucket cap | hard cap (like `Adaptive`) |
//! | `Adaptive` | `q_(1-tail)` of a decaying sketch, with `tail` steered by feedback | **hard cap**: hedges <= eps * primaries + burst |

use crate::sketch::DecayingSketch;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyKind {
    None,
    Fixed,
    FixedCapped,
    Eager,
    Adaptive,
}

impl PolicyKind {
    pub const ALL: [PolicyKind; 5] =
        [PolicyKind::None, PolicyKind::Fixed, PolicyKind::FixedCapped, PolicyKind::Eager, PolicyKind::Adaptive];

    /// Whether hedges are gated by the token bucket.
    pub fn is_capped(self) -> bool {
        matches!(self, PolicyKind::FixedCapped | PolicyKind::Adaptive)
    }

    pub fn id(self) -> &'static str {
        match self {
            PolicyKind::None => "none",
            PolicyKind::Fixed => "fixed",
            PolicyKind::FixedCapped => "fixed_capped",
            PolicyKind::Eager => "eager",
            PolicyKind::Adaptive => "adaptive",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PolicyKind::None => "No hedging",
            PolicyKind::Fixed => "Fixed-percentile hedge",
            PolicyKind::FixedCapped => "Fixed + budget cap",
            PolicyKind::Eager => "Eager duplicate",
            PolicyKind::Adaptive => "Budgeted adaptive hedge",
        }
    }
}

/// Minimum effective sample count before the adaptive policy trusts its sketch.
const MIN_SAMPLES: f64 = 300.0;
/// Half-life of the latency window, in seconds.
const HALF_LIFE_S: f64 = 10.0;
/// EWMA smoothing of the observed hedge-demand rate (per control tick).
const SMOOTH: f64 = 0.05;
/// Feedback gain on the (relative) demand error, per control tick.
const GAIN: f64 = 0.08;
/// The controller aims below the hard cap so the token bucket stays stocked and
/// can absorb bursts (e.g. a whole slow episode at once). The cap is a safety
/// net, not the operating point.
const TARGET_FRAC: f64 = 0.7;
const TAIL_MIN: f64 = 1.0e-4;
const TAIL_MAX: f64 = 0.5;

#[derive(Clone, Debug)]
pub struct Policy {
    kind: PolicyKind,
    eps: f64,
    burst: f64,
    sketch: DecayingSketch,
    tokens: f64,
    fixed_delay_ms: Option<f64>,
    /// Tail mass the delay targets: delay = quantile(1 - tail).
    tail: f64,
    demand_ewma: f64,
    tick_primaries: u32,
    tick_attempts: u32,
}

impl Policy {
    pub fn new(kind: PolicyKind, eps: f64, burst: f64) -> Self {
        Policy {
            kind,
            eps,
            burst,
            sketch: DecayingSketch::new(0.01),
            tokens: burst.min(1.0),
            fixed_delay_ms: None,
            tail: TARGET_FRAC * eps,
            demand_ewma: TARGET_FRAC * eps,
            tick_primaries: 0,
            tick_attempts: 0,
        }
    }

    pub fn kind(&self) -> PolicyKind {
        self.kind
    }

    /// Delay (ms) after which a still-outstanding primary should be hedged,
    /// or `None` if it should not be hedged at all right now.
    pub fn delay_ms(&self) -> Option<f64> {
        match self.kind {
            PolicyKind::None => None,
            PolicyKind::Eager => Some(0.0),
            PolicyKind::Fixed | PolicyKind::FixedCapped => self.fixed_delay_ms,
            PolicyKind::Adaptive => {
                if self.sketch.total() >= MIN_SAMPLES {
                    self.sketch.quantile(1.0 - self.tail)
                } else {
                    None
                }
            }
        }
    }

    /// A new primary request was issued (earns hedge budget).
    pub fn on_primary(&mut self) {
        self.tick_primaries += 1;
        if self.kind.is_capped() {
            self.tokens = (self.tokens + self.eps).min(self.burst);
        }
    }

    /// A hedge timer fired for a still-outstanding request. Returns whether the
    /// hedge may actually be sent. This is where the load guarantee lives.
    pub fn allow_hedge(&mut self) -> bool {
        self.tick_attempts += 1;
        match self.kind {
            PolicyKind::None => false,
            PolicyKind::Fixed | PolicyKind::Eager => true,
            PolicyKind::FixedCapped | PolicyKind::Adaptive => {
                if self.tokens >= 1.0 {
                    self.tokens -= 1.0;
                    true
                } else {
                    false
                }
            }
        }
    }

    /// Record the first-response latency of a finished sub-request.
    pub fn observe(&mut self, latency_ms: f64) {
        self.sketch.add(latency_ms);
    }

    /// Called once when the warm-up window ends.
    pub fn end_warmup(&mut self) {
        if matches!(self.kind, PolicyKind::Fixed | PolicyKind::FixedCapped) {
            self.fixed_delay_ms = self.sketch.quantile(1.0 - self.eps);
        }
    }

    /// Control tick of length `dt_s`.
    pub fn tick(&mut self, dt_s: f64) {
        if self.kind == PolicyKind::Adaptive {
            self.sketch.decay(0.5f64.powf(dt_s / HALF_LIFE_S));
            if self.tick_primaries > 0 {
                let demand = self.tick_attempts as f64 / self.tick_primaries as f64;
                self.demand_ewma += SMOOTH * (demand - self.demand_ewma);
            }
            // Multiplicative update on the tail mass: demand above budget makes
            // the delay longer, below budget makes it shorter. Scale-free in eps.
            let target = TARGET_FRAC * self.eps;
            let rel_err = (self.demand_ewma - target) / target;
            self.tail = (self.tail * (-GAIN * rel_err).exp()).clamp(TAIL_MIN, TAIL_MAX);
        }
        self.tick_primaries = 0;
        self.tick_attempts = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn none_never_hedges_eager_always_does() {
        let mut n = Policy::new(PolicyKind::None, 0.05, 10.0);
        assert!(n.delay_ms().is_none());
        assert!(!n.allow_hedge());
        let mut e = Policy::new(PolicyKind::Eager, 0.05, 10.0);
        assert_eq!(e.delay_ms(), Some(0.0));
        assert!(e.allow_hedge());
    }

    #[test]
    fn token_bucket_bounds_hedges() {
        let eps = 0.02;
        let burst = 5.0;
        let mut p = Policy::new(PolicyKind::Adaptive, eps, burst);
        let (mut primaries, mut sent) = (0u64, 0u64);
        // Adversarial: every primary immediately demands a hedge.
        for _ in 0..100_000 {
            p.on_primary();
            primaries += 1;
            if p.allow_hedge() {
                sent += 1;
            }
            assert!(sent as f64 <= eps * primaries as f64 + burst + 1e-9, "sent {sent} of {primaries}");
        }
        assert!(sent as f64 >= eps * primaries as f64 - burst - 1.0);
    }

    #[test]
    fn adaptive_delay_moves_with_regime() {
        let mut p = Policy::new(PolicyKind::Adaptive, 0.05, 10.0);
        for _ in 0..2000 {
            p.observe(10.0);
        }
        let low = p.delay_ms().unwrap();
        for _ in 0..60 {
            p.tick(0.1);
            for _ in 0..200 {
                p.observe(40.0);
            }
        }
        let high = p.delay_ms().unwrap();
        assert!(high > low * 2.0, "low {low} high {high}");
    }
}
