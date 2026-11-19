//! hedgeq: interactive lab and CLI for budgeted, quantile-adaptive request hedging.

mod eval;
mod server;

use std::net::SocketAddr;
use std::process::ExitCode;

const USAGE: &str = "\
hedgeq - budgeted, quantile-adaptive request hedging

USAGE:
    hedgeq serve [--addr <ip:port>]   Start the interactive lab (default 127.0.0.1:8080)
    hedgeq eval  [--seeds <n>]        Print the evaluation table used in the README
    hedgeq help                       Show this message
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("serve") => {
            let addr = match flag(&args, "--addr") {
                Some(a) => match a.parse::<SocketAddr>() {
                    Ok(a) => a,
                    Err(e) => return fail(&format!("invalid --addr '{a}': {e}")),
                },
                None => SocketAddr::from(([127, 0, 0, 1], 8080)),
            };
            server::serve(addr)
        }
        Some("eval") => {
            let seeds = match flag(&args, "--seeds") {
                Some(s) => match s.parse::<u64>() {
                    Ok(n) if (1..=50).contains(&n) => n,
                    _ => return fail("--seeds must be an integer between 1 and 50"),
                },
                None => 5,
            };
            eval::run(seeds);
            ExitCode::SUCCESS
        }
        Some("help") | Some("--help") | Some("-h") | None => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        Some(other) => fail(&format!("unknown command '{other}'\n\n{USAGE}")),
    }
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(String::as_str)
}

fn fail(msg: &str) -> ExitCode {
    eprintln!("error: {msg}");
    ExitCode::from(2)
}
