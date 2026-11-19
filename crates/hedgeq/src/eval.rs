//! `hedgeq eval`: the evaluation table used in the README. Medians over seeds.

use hedgeq_core::{run_all, SimConfig};

struct Scenario {
    name: &'static str,
    cfg: SimConfig,
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

pub fn run(seeds: u64) {
    let base = SimConfig { duration_s: 90.0, warmup_s: 8.0, ..SimConfig::default() };
    let scenarios = [
        Scenario { name: "Steady state", cfg: base.clone() },
        Scenario { name: "Load surge (x1.6 at midpoint)", cfg: SimConfig { surge_factor: 1.6, ..base.clone() } },
        Scenario { name: "Degrading fleet (4x stragglers at midpoint)", cfg: SimConfig { degrade_factor: 4.0, ..base.clone() } },
        Scenario {
            name: "Surge and degradation together",
            cfg: SimConfig { surge_factor: 1.6, degrade_factor: 3.0, ..base.clone() },
        },
        Scenario { name: "Correlated stragglers (80% of replicas)", cfg: SimConfig { correlation: 0.8, ..base.clone() } },
        Scenario { name: "Wide fan-out (100 shards)", cfg: SimConfig { fanout: 100, utilization: 0.4, ..base.clone() } },
    ];

    println!(
        "Median over {seeds} seeds. Budget epsilon = {:.0}%, fan-out {}, {} replicas, base utilisation {:.0}%.\n",
        base.budget * 100.0,
        base.fanout,
        base.replicas,
        base.utilization * 100.0
    );
    println!("| Scenario | Policy | p99 (ms) | p99.9 (ms) | Extra requests |");
    println!("|---|---|---:|---:|---:|");
    for sc in &scenarios {
        let runs: Vec<_> = (1..=seeds).map(|s| run_all(&SimConfig { seed: s, ..sc.cfg.clone() })).collect();
        let n = runs[0].results.len();
        for i in 0..n {
            let mut p99: Vec<f64> = runs.iter().map(|r| r.results[i].user.p99).collect();
            let mut p999: Vec<f64> = runs.iter().map(|r| r.results[i].user.p999).collect();
            let mut extra: Vec<f64> = runs.iter().map(|r| r.results[i].extra_pct).collect();
            let label = runs[0].results[i].label;
            let name = if i == 0 { sc.name } else { "" };
            println!(
                "| {} | {} | {:.0} | {:.0} | {:.1}% |",
                name,
                label,
                median(&mut p99),
                median(&mut p999),
                median(&mut extra)
            );
        }
    }
}
