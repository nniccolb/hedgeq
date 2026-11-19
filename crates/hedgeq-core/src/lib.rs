//! # hedgeq-core
//!
//! Budgeted, quantile-adaptive request hedging, plus a deterministic
//! discrete-event simulator of a replicated, fan-out service for evaluating it.

pub mod policy;
pub mod rng;
pub mod sim;
pub mod sketch;

pub use policy::{Policy, PolicyKind};
pub use sim::{run, run_all, Comparison, PolicyResult, SimConfig};
