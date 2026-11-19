# hedgeq

**Budgeted, quantile-adaptive request hedging for fan-out services**, with a deterministic simulator and an interactive lab.

> *Hedge your bets, within a budget.*

In a service that fans each request out to many replicated shards, rare per-server stalls become the typical user experience: a request is as slow as its slowest part. **Hedging** (sending a duplicate to another replica after a delay and keeping the first answer) repairs the tail, but a fixed delay silently over- or under-spends as load and failure rates drift. `hedgeq` learns the delay online and enforces the extra-load budget as a hard invariant.

## Abstract

We learn the hedge delay from a decaying, relative-error quantile sketch, steer it with a feedback controller toward a fraction of the budget, and enforce the budget absolutely with a token bucket. In a deterministic simulator with paired random numbers, the adaptive policy stayed under its budget in every scenario tested, matched a fixed delay in steady state, and cut p99.9 by roughly 1.4-2.3x when load or failure rates drifted, at the same cap.

## Method

| | Mechanism | Property |
|---|---|---|
| **Observe** | Log-bucketed histogram (relative error <= 1%) with exponential decay, half-life 10 s | Tracks the *current* regime |
| **Control** | Delay = `Q(1 - tau)` of the sketch; every 100 ms a multiplicative controller adjusts the tail mass `tau` so hedge demand settles at 70% of the budget | Closed loop, scale-free in the budget |
| **Cap** | Token bucket: each primary earns `epsilon` tokens, each hedge spends one | `hedges <= epsilon * primaries + B`, always |

The bound in the last row is enforced in `Policy::allow_hedge` and verified by a property test against an adversary that asks for a hedge on every request.

## Evaluation

Deterministic discrete-event simulation: 20 shards x 3 replicas, log-normal service times (median 5 ms), transient slowdown episodes (2% of time, 12x slower), 45% nominal utilisation, budget epsilon = 5%. Every policy sees **identical** arrivals, work and slowdown episodes (keyed random numbers). Regime shifts occur at the midpoint of a 90 s run. Median over 5 seeds.

| Scenario | Policy | p99 (ms) | p99.9 (ms) | Extra requests |
|---|---|---:|---:|---:|
| Steady state | No hedging | 453 | 616 | 0.0% |
|  | Fixed-percentile hedge | 59 | 149 | 2.9% |
|  | Fixed + budget cap | 59 | 149 | 2.9% |
|  | Eager duplicate | 50 | 119 | 100.0% |
|  | **Budgeted adaptive hedge** | 59 | 161 | 3.6% |
| Load surge (x1.6 at midpoint) | No hedging | 592 | 762 | 0.0% |
|  | Fixed-percentile hedge | 138 | 192 | 11.5% |
|  | Fixed + budget cap | 387 | 538 | 4.2% |
|  | Eager duplicate | 454 | 469 | 100.0% |
|  | **Budgeted adaptive hedge** | 154 | 238 | 3.4% |
| Degrading fleet (4x stragglers at midpoint) | No hedging | 587 | 808 | 0.0% |
|  | Fixed-percentile hedge | 180 | 275 | 6.8% |
|  | Fixed + budget cap | 475 | 648 | 3.9% |
|  | Eager duplicate | 176 | 286 | 100.0% |
|  | **Budgeted adaptive hedge** | 280 | 377 | 3.4% |
| Surge and degradation together | No hedging | 717 | 950 | 0.0% |
|  | Fixed-percentile hedge | 268 | 344 | 20.1% |
|  | Fixed + budget cap | 649 | 775 | 4.2% |
|  | Eager duplicate | 1766 | 1812 | 100.0% |
|  | **Budgeted adaptive hedge** | 440 | 536 | 3.3% |
| Correlated stragglers (80% of replicas) | No hedging | 472 | 600 | 0.0% |
|  | Fixed-percentile hedge | 435 | 568 | 4.2% |
|  | Fixed + budget cap | 437 | 576 | 4.0% |
|  | Eager duplicate | 478 | 617 | 100.0% |
|  | **Budgeted adaptive hedge** | 425 | 568 | 3.5% |
| Wide fan-out (100 shards) | No hedging | 606 | 806 | 0.0% |
|  | Fixed-percentile hedge | 129 | 215 | 3.4% |
|  | Fixed + budget cap | 134 | 255 | 3.4% |
|  | Eager duplicate | 124 | 205 | 100.0% |
|  | **Budgeted adaptive hedge** | 131 | 212 | 3.6% |

Reproduce: `cargo run --release -p hedgeq -- eval`.

**Reading the table honestly**

- In steady state the adaptive policy *matches* a well-tuned fixed delay (p99.9 is a little worse in this table). Adaptivity earns its keep only when conditions drift.
- Under drift, at the **same hard cap**, adaptive cuts p99.9 by about 1.4-2.3x versus a fixed delay.
- The *uncapped* fixed delay often has the best latency under drift, but only by spending 1.4-4x its design budget (up to 20% extra requests). That is the overload risk the cap is there to remove; the lab shows it live.
- With correlated stragglers nothing helps, by construction: hedges have nowhere to escape to.

## Interactive lab

```bash
cargo run --release -p hedgeq -- serve        # http://127.0.0.1:8080
```

Pick a scenario or drag the sliders (load, fan-out, replicas, straggler rate and severity, correlation, regime shifts, budget). Each run replays one workload under all five policies and shows the percentile spectrum, p99 over time, extra-request rate, and hedge delay, with hover tooltips and a table view. The page makes no external requests and the server binds to loopback by default.

## Repository layout

```
crates/hedgeq-core/   policy, quantile sketch, deterministic simulator (library, 1 dependency: serde)
crates/hedgeq/        CLI: `serve` (axum + embedded UI) and `eval`
```

## Develop

Requires a recent stable Rust toolchain.

```bash
cargo test --workspace            # unit + property-style tests, including the budget invariant
cargo clippy --workspace --all-targets
```

## Limitations

- Results are from a simulator, not a production system. Queues are single-server FIFO, service times are log-normal, slowdowns are on/off episodes, and cancellation is instant.
- Slowdown is sampled when service *starts*; an episode beginning mid-request does not slow that request.
- Replica choice is uniform random; a load-aware balancer would shrink every policy's absolute tail.
- The controller constants (half-life, gain, 70% target) were tuned by hand on the scenarios above, not fitted out of sample.

## License

MIT
