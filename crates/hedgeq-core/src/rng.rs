//! Small, dependency-free, deterministic randomness.
//!
//! Two flavours are provided:
//! * [`Rng`]: a sequential SplitMix64 stream (arrivals, failure episodes).
//! * [`unit`]: a *stateless* keyed uniform. The simulator draws every
//!   per-request quantity (service times, replica choice) from it, so all
//!   policies see exactly the same underlying work for the same seed
//!   (common random numbers). Differences between policies are therefore
//!   caused by the policy, not by sampling noise.

const GOLDEN: u64 = 0x9E37_79B9_7F4A_7C15;

#[inline]
pub fn mix(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Stateless uniform sample in the open interval (0, 1) keyed by `(seed, a, b)`.
#[inline]
pub fn unit(seed: u64, a: u64, b: u64) -> f64 {
    let h = mix(seed ^ mix(a.wrapping_add(GOLDEN)) ^ mix(b.wrapping_mul(GOLDEN).wrapping_add(0x1234_5678_9ABC_DEF1)));
    (((h >> 11) as f64) + 0.5) / ((1u64 << 53) as f64)
}

/// Standard normal from two uniforms (Box-Muller).
#[inline]
pub fn normal(u1: f64, u2: f64) -> f64 {
    (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
}

/// Sequential SplitMix64 stream.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(mix(seed ^ 0xD1B5_4A32_D192_ED03))
    }
    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(GOLDEN);
        mix(self.0)
    }
    /// Uniform in the open interval (0, 1).
    #[inline]
    pub fn uniform(&mut self) -> f64 {
        (((self.next_u64() >> 11) as f64) + 0.5) / ((1u64 << 53) as f64)
    }
    /// Exponential with the given mean.
    #[inline]
    pub fn exp(&mut self, mean: f64) -> f64 {
        -mean * self.uniform().ln()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_is_deterministic_and_in_range() {
        for i in 0..10_000u64 {
            let a = unit(7, i, 1);
            assert!(a > 0.0 && a < 1.0);
            assert_eq!(a, unit(7, i, 1));
        }
        assert_ne!(unit(7, 1, 1), unit(8, 1, 1));
        assert_ne!(unit(7, 1, 1), unit(7, 1, 2));
    }

    #[test]
    fn exp_has_requested_mean() {
        let mut r = Rng::new(42);
        let n = 200_000;
        let m: f64 = (0..n).map(|_| r.exp(3.0)).sum::<f64>() / n as f64;
        assert!((m - 3.0).abs() < 0.05, "mean {m}");
    }
}
