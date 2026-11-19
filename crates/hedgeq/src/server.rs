//! Local HTTP server: serves the lab UI and a small JSON API around the simulator.

use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, State},
    http::{header, HeaderValue, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use hedgeq_core::{run_all, SimConfig};
use serde_json::json;
use std::{net::SocketAddr, process::ExitCode, sync::Arc};
use tokio::sync::Semaphore;

const INDEX_HTML: &str = include_str!("../ui/index.html");
const APP_JS: &str = include_str!("../ui/app.js");
const STYLE_CSS: &str = include_str!("../ui/style.css");

/// Each simulation already fans out across several threads, so keep this small.
const MAX_CONCURRENT_SIMS: usize = 2;

#[derive(Clone)]
struct AppState {
    permits: Arc<Semaphore>,
}

pub fn serve(addr: SocketAddr) -> ExitCode {
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("error: could not start runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    rt.block_on(async move {
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("error: could not bind {addr}: {e}");
                return ExitCode::FAILURE;
            }
        };
        if !addr.ip().is_loopback() {
            eprintln!("warning: listening on a non-loopback address; the lab has no authentication.");
        }
        println!("hedgeq lab running at http://{addr}  (Ctrl+C to stop)");
        let app = router(AppState { permits: Arc::new(Semaphore::new(MAX_CONCURRENT_SIMS)) });
        let served = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = tokio::signal::ctrl_c().await;
            })
            .await;
        match served {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::FAILURE
            }
        }
    })
}

fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(|| async { asset("text/html; charset=utf-8", INDEX_HTML) }))
        .route("/app.js", get(|| async { asset("text/javascript; charset=utf-8", APP_JS) }))
        .route("/style.css", get(|| async { asset("text/css; charset=utf-8", STYLE_CSS) }))
        .route("/healthz", get(|| async { "ok" }))
        .route("/api/defaults", get(defaults))
        .route("/api/simulate", post(simulate))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(middleware::map_response(security_headers))
        .with_state(state)
}

fn asset(content_type: &'static str, body: &'static str) -> Response {
    ([(header::CONTENT_TYPE, content_type)], body).into_response()
}

async fn security_headers(mut res: Response) -> Response {
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        ),
    );
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

async fn defaults() -> impl IntoResponse {
    Json(SimConfig::default())
}

fn bad_request(msg: impl Into<String>) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg.into() }))).into_response()
}

async fn simulate(State(state): State<AppState>, body: Result<Json<SimConfig>, JsonRejection>) -> Response {
    let cfg = match body {
        Ok(Json(c)) => c,
        Err(e) => return bad_request(format!("invalid request: {}", e.body_text())),
    };
    if let Err(msg) = cfg.validate() {
        return bad_request(msg);
    }
    let Ok(_permit) = state.permits.clone().try_acquire_owned() else {
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": "the lab is busy; try again in a moment" })))
            .into_response();
    };
    match tokio::task::spawn_blocking(move || run_all(&cfg)).await {
        Ok(cmp) => Json(cmp).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "simulation failed" }))).into_response(),
    }
}
