# hedgeq

**Budgeted, quantile-adaptive request hedging for fan-out services**, with a deterministic simulator and an interactive lab.

> *Hedge your bets, within a budget.*

In a service that fans each request out to many replicated shards, rare per-server stalls become the typical user experience: a request is as slow as its slowest part. **Hedging** (sending a duplicate to another replica after a delay and keeping the first answer) repairs the tail, but a fixed delay silently over- or under-spends as load and failure rates drift. `hedgeq` learns the delay online and enforces the extra-load budget as a hard invariant.

## Abstract

We learn the hedge delay from a decaying, relative-error quantile sketch, steer it with a feedback controller toward a fraction of the budget, and enforce the budget absolutely with a token bucket. In a deterministic simulator with paired random numbers, the adaptive policy stayed under its budget in every scenario tested, matched a fixed delay in steady state, and cut p99.9 by roughly 1.4-2.3x when load or failure rates drifted, at the same cap.

## Background

Hedged requests, and the observation that fan-out amplifies rare per-server slowness into common user-visible latency, are described in:

> Jeffrey Dean and Luiz André Barroso. **The Tail at Scale.** *Communications of the ACM* 56(2), February 2013, pp. 74-80. doi:[10.1145/2408776.2408794](https://doi.org/10.1145/2408776.2408794)

```bibtex
@article{dean2013tail,
  author  = {Dean, Jeffrey and Barroso, Luiz Andr{\'e}},
  title   = {The Tail at Scale},
  journal = {Communications of the ACM},
  volume  = {56},
  number  = {2},
  pages   = {74--80},
  year    = {2013},
  doi     = {10.1145/2408776.2408794}
}
```

That work hedges after a fixed delay (for example the 95th percentile of expected latency). `hedgeq` builds on the idea by learning the delay online and enforcing the extra-load budget as a hard invariant; it is an independent implementation and evaluation, not affiliated with the authors.

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

## Interactive demo

```bash
cargo run --release -p hedgeq -- serve        # http://127.0.0.1:8080
```

The page is a short technical note. Figure 1 shows two copies of an analytics page: a rotating 3D heatmap of live events by location plus totals. The events live on 20 shards, and every column height and total is a sum over all of them, so the page cannot appear until the slowest shard answers. The left copy is served without hedging, the right with adaptive hedging. Each square in the loading state is one shard query; the page appears at the moment the last square fills. Both copies replay the same recorded requests, so any difference is the policy. Drag a heatmap to rotate it.

The demo uses a deliberately severe setting (servers stall 3% of the time at 40x slower, 20 shards, 10% extra-request budget) so the effect is easy to see. It opens with the slowest recorded load and then replays loads that were slow without hedging; "Include fast loads" shows all of them. The events drawn are synthetic; only the timing is real. The 3D view is plain canvas code with no libraries, and the page makes no external requests. The server binds to loopback by default.

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
