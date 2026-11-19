//! A decaying, relative-error quantile sketch.
//!
//! Values are mapped to logarithmic buckets (as in DDSketch), so any returned
//! quantile is within `alpha` relative error of a value in the data. Bucket
//! weights are multiplied by a decay factor every control tick, which turns the
//! sketch into an exponentially-weighted window over recent observations: the
//! estimate tracks regime changes instead of averaging them away.

const MIN_MS: f64 = 0.01;
const MAX_MS: f64 = 1.0e6;

#[derive(Clone, Debug)]
pub struct DecayingSketch {
    ln_gamma: f64,
    buckets: Vec<f64>,
    total: f64,
}

impl DecayingSketch {
    /// `alpha` is the target relative error, e.g. `0.01` for 1%.
    pub fn new(alpha: f64) -> Self {
        assert!(alpha > 0.0 && alpha < 0.5);
        let gamma = (1.0 + alpha) / (1.0 - alpha);
        let ln_gamma = gamma.ln();
        let n = ((MAX_MS / MIN_MS).ln() / ln_gamma).ceil() as usize + 2;
        DecayingSketch { ln_gamma, buckets: vec![0.0; n], total: 0.0 }
    }

    #[inline]
    fn index(&self, ms: f64) -> usize {
        let v = ms.clamp(MIN_MS, MAX_MS);
        let i = ((v / MIN_MS).ln() / self.ln_gamma).ceil() as usize;
        i.min(self.buckets.len() - 1)
    }

    #[inline]
    fn value(&self, i: usize) -> f64 {
        // Midpoint (in the relative-error sense) of bucket i.
        let gamma = self.ln_gamma.exp();
        MIN_MS * gamma.powi(i as i32) * 2.0 / (1.0 + gamma)
    }

    pub fn add(&mut self, ms: f64) {
        if !ms.is_finite() {
            return;
        }
        let i = self.index(ms);
        self.buckets[i] += 1.0;
        self.total += 1.0;
    }

    /// Multiply every weight by `factor` in `(0, 1]`.
    pub fn decay(&mut self, factor: f64) {
        for b in &mut self.buckets {
            *b *= factor;
        }
        self.total *= factor;
    }

    /// Effective (decayed) number of observations.
    pub fn total(&self) -> f64 {
        self.total
    }

    /// Estimated `q`-quantile, or `None` if the sketch is empty.
    pub fn quantile(&self, q: f64) -> Option<f64> {
        if self.total <= 0.0 {
            return None;
        }
        let rank = q.clamp(0.0, 1.0) * self.total;
        let mut acc = 0.0;
        for (i, w) in self.buckets.iter().enumerate() {
            acc += w;
            if acc >= rank && *w > 0.0 {
                return Some(self.value(i));
            }
        }
        // Rounding fallback: highest populated bucket.
        self.buckets.iter().rposition(|w| *w > 0.0).map(|i| self.value(i))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::{normal, Rng};

    #[test]
    fn quantiles_are_within_relative_error() {
        let mut r = Rng::new(1);
        let mut s = DecayingSketch::new(0.01);
        let mut xs: Vec<f64> = (0..100_000).map(|_| (2.0 + 0.8 * normal(r.uniform(), r.uniform())).exp()).collect();
        for &x in &xs {
            s.add(x);
        }
        xs.sort_by(|a, b| a.total_cmp(b));
        for q in [0.5, 0.9, 0.99, 0.999] {
            let exact = xs[((q * xs.len() as f64).ceil() as usize - 1).min(xs.len() - 1)];
            let est = s.quantile(q).unwrap();
            assert!((est - exact).abs() / exact < 0.03, "q={q} est={est} exact={exact}");
        }
    }

    #[test]
    fn decay_forgets_old_regime() {
        let mut s = DecayingSketch::new(0.01);
        for _ in 0..10_000 {
            s.add(10.0);
        }
        for _ in 0..200 {
            s.decay(0.9);
            for _ in 0..50 {
                s.add(100.0);
            }
        }
        let med = s.quantile(0.5).unwrap();
        assert!(med > 90.0, "median {med} should have moved to the new regime");
    }

    #[test]
    fn empty_sketch_has_no_quantile() {
        assert!(DecayingSketch::new(0.01).quantile(0.5).is_none());
    }
}
