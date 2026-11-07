use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteConnectOptions, Row, SqlitePool};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::Mutex;
use tower_http::services::{ServeDir, ServeFile};

type Reply = Result<Json<Value>, (StatusCode, &'static str)>;
struct App {
    db: SqlitePool,
    admin: String,
    hook: String,
    media: String,
    client: reqwest::Client,
    changes: Mutex<()>,
}
fn denied() -> (StatusCode, &'static str) {
    (StatusCode::UNAUTHORIZED, "Authentication required")
}
fn failure() -> (StatusCode, &'static str) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "Relay configuration unavailable; retry shortly",
    )
}
fn equal(a: &str, b: &str) -> bool {
    Sha256::digest(a.as_bytes())
        .iter()
        .zip(Sha256::digest(b.as_bytes()))
        .fold(0u8, |v, (a, b)| v | (a ^ b))
        == 0
}
fn authorize(app: &App, headers: &HeaderMap) -> Result<(), (StatusCode, &'static str)> {
    let value = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(denied)?;
    if !equal(value, &app.admin) {
        return Err(denied());
    }
    Ok(())
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}
fn key() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
async fn media_path(app: &App, id: &str, secret: &str) -> Result<(), (StatusCode, &'static str)> {
    // Channel creation is explicit; publishers cannot create arbitrary paths.
    let url = format!("{}/v3/config/paths/add/streams/{id}", app.media);
    app.client.post(url).json(&json!({"source":"publisher", "overridePublisher":false, "srtPublishPassphrase":secret,"record":false})).send().await.map_err(|_|failure())?.error_for_status().map_err(|_|failure())?;
    Ok(())
}
async fn remove_media(app: &App, id: &str) -> Result<(), (StatusCode, &'static str)> {
    let r = app
        .client
        .delete(format!("{}/v3/config/paths/delete/streams/{id}", app.media))
        .send()
        .await
        .map_err(|_| failure())?;
    if r.status().is_success() || r.status() == reqwest::StatusCode::NOT_FOUND {
        Ok(())
    } else {
        Err(failure())
    }
}
async fn channels(State(app): State<Arc<App>>) -> Reply {
    let rows = sqlx::query("SELECT id,name FROM channels ORDER BY id")
        .fetch_all(&app.db)
        .await
        .map_err(|_| failure())?;
    let status = app
        .client
        .get(format!("{}/v3/paths/list", app.media))
        .send()
        .await
        .map_err(|_| failure())?
        .error_for_status()
        .map_err(|_| failure())?
        .json::<Value>()
        .await
        .map_err(|_| failure())?;
    let entries:Vec<Value>=rows.iter().map(|r| {
        let id:String=r.get("id"); let path=format!("streams/{id}");
        let live=status["items"].as_array().and_then(|items|items.iter().find(|v|v["name"]==path));
        json!({"id":id,"name":r.get::<String,_>("name"),"path":format!("/{path}/index.m3u8"),"online":live.is_some_and(|v|v["ready"]==true),"readers":live.and_then(|v|v["readers"].as_array()).map_or(0,Vec::len)})
    }).collect();
    Ok(Json(json!({"channels":entries})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewChannel {
    id: String,
    name: String,
}
async fn create(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(body): Json<NewChannel>,
) -> Reply {
    authorize(&app, &headers)?;
    if !valid_id(&body.id)
        || body.name.trim().is_empty()
        || body.name.len() > 100
        || body.name.chars().any(char::is_control)
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Use a lowercase channel ID and a name of 1–100 characters",
        ));
    }
    let _change = app.changes.lock().await;
    if sqlx::query("SELECT id FROM channels WHERE id=?")
        .bind(&body.id)
        .fetch_optional(&app.db)
        .await
        .map_err(|_| failure())?
        .is_some()
    {
        return Err((StatusCode::CONFLICT, "Channel ID already exists"));
    }
    let secret = key();
    media_path(&app, &body.id, &secret).await?;
    if sqlx::query("INSERT INTO channels(id,name,secret) VALUES(?,?,?)")
        .bind(&body.id)
        .bind(body.name.trim())
        .bind(&secret)
        .execute(&app.db)
        .await
        .is_err()
    {
        let _ = remove_media(&app, &body.id).await;
        return Err(failure());
    }
    Ok(Json(json!({"id":body.id,"publishingKey":secret})))
}
async fn delete(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<String>) -> Reply {
    authorize(&app, &headers)?;
    if !valid_id(&id) {
        return Err((StatusCode::BAD_REQUEST, "Invalid channel"));
    }
    let _change = app.changes.lock().await;
    // Revoke authentication before closing the live path.
    sqlx::query("DELETE FROM channels WHERE id=?")
        .bind(&id)
        .execute(&app.db)
        .await
        .map_err(|_| failure())?;
    remove_media(&app, &id).await?;
    Ok(Json(json!({"ok":true})))
}
async fn rotate(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<String>) -> Reply {
    authorize(&app, &headers)?;
    if !valid_id(&id) {
        return Err((StatusCode::BAD_REQUEST, "Invalid channel"));
    }
    let _change = app.changes.lock().await;
    let secret = key();
    let result = sqlx::query("UPDATE channels SET secret=? WHERE id=?")
        .bind(&secret)
        .bind(&id)
        .execute(&app.db)
        .await
        .map_err(|_| failure())?;
    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "Channel not found"));
    }
    remove_media(&app, &id).await?;
    media_path(&app, &id, &secret).await?;
    Ok(Json(json!({"id":id,"publishingKey":secret})))
}
#[derive(Deserialize)]
struct Auth {
    user: String,
    password: String,
    action: String,
    path: String,
    protocol: String,
}
async fn auth(
    State(app): State<Arc<App>>,
    Path(token): Path<String>,
    Json(body): Json<Auth>,
) -> StatusCode {
    if !equal(&token, &app.hook) {
        return StatusCode::UNAUTHORIZED;
    }
    let Some(id) = body.path.strip_prefix("streams/").filter(|id| valid_id(id)) else {
        return StatusCode::UNAUTHORIZED;
    };
    let row = sqlx::query("SELECT secret FROM channels WHERE id=?")
        .bind(id)
        .fetch_optional(&app.db)
        .await;
    let Ok(Some(row)) = row else {
        return StatusCode::UNAUTHORIZED;
    };
    if body.action == "read" && body.protocol == "hls" {
        return StatusCode::NO_CONTENT;
    }
    if body.action == "publish"
        && body.protocol == "srt"
        && body.user == id
        && equal(&body.password, &row.get::<String, _>("secret"))
    {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::UNAUTHORIZED
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let admin = std::env::var("RELAY_ADMIN_TOKEN")?;
    let hook = std::env::var("RELAY_HOOK_TOKEN")?;
    if admin.len() < 32 || hook.len() < 32 || admin == hook {
        return Err("Use different admin/hook tokens of at least 32 characters".into());
    }
    let home = PathBuf::from(std::env::var("RELAY_HOME").unwrap_or("/data".into()));
    tokio::fs::create_dir_all(&home).await?;
    let db = SqlitePool::connect_with(
        SqliteConnectOptions::new()
            .filename(home.join("relay.db"))
            .create_if_missing(true),
    )
    .await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,secret TEXT NOT NULL)").execute(&db).await?;
    let app = Arc::new(App {
        db,
        admin,
        hook,
        media: std::env::var("RELAY_MEDIA_API").unwrap_or("http://mediamtx:9997".into()),
        client: reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()?,
        changes: Mutex::new(()),
    });
    // Wait for the media API before restoring persistent channel configuration.
    for _ in 0..30 {
        if app
            .client
            .get(format!("{}/v3/paths/list", app.media))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    // Restore only channel configuration after a restart, never media or schedules.
    let rows = sqlx::query("SELECT id,secret FROM channels")
        .fetch_all(&app.db)
        .await?;
    for r in rows {
        remove_media(&app, &r.get::<String, _>("id"))
            .await
            .map_err(|_| "Media server unavailable")?;
        media_path(
            &app,
            &r.get::<String, _>("id"),
            &r.get::<String, _>("secret"),
        )
        .await
        .map_err(|_| "Media server unavailable")?;
    }
    let reconcile = Arc::clone(&app);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let _lock = reconcile.changes.lock().await;
            if let Ok(rows) = sqlx::query("SELECT id,secret FROM channels")
                .fetch_all(&reconcile.db)
                .await
            {
                for r in rows {
                    let id: String = r.get("id");
                    if reconcile
                        .client
                        .get(format!(
                            "{}/v3/config/paths/get/streams/{id}",
                            reconcile.media
                        ))
                        .send()
                        .await
                        .is_ok_and(|r| r.status() == reqwest::StatusCode::NOT_FOUND)
                    {
                        let _ = media_path(&reconcile, &id, &r.get::<String, _>("secret")).await;
                    }
                }
            }
        }
    });
    let root = std::env::var("BROADCAST_WEB_ROOT").unwrap_or("/app/web".into());
    let public = Router::new()
        .route(
            "/",
            get(|| async { axum::response::Redirect::temporary("/relay/") }),
        )
        .route(
            "/api/health",
            get(|| async { Json(json!({"ok":true,"service":"signaldesk-relay"})) }),
        )
        .route("/api/channels", get(channels).post(create))
        .route("/api/channels/{id}", axum::routing::delete(delete))
        .route("/api/channels/{id}/rotate", post(rotate))
        .fallback_service(
            ServeDir::new(&root)
                .not_found_service(ServeFile::new(format!("{root}/relay/index.html"))),
        )
        .layer(axum::extract::DefaultBodyLimit::max(4096))
        .with_state(Arc::clone(&app));
    // Authentication callback has no published port and is inaccessible through the gateway.
    let private = Router::new()
        .route("/auth/{token}", post(auth))
        .layer(axum::extract::DefaultBodyLimit::max(8192))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind("0.0.0.0:9790").await?;
    let hook_listener = tokio::net::TcpListener::bind("0.0.0.0:9791").await?;
    tokio::spawn(async move {
        let _ = axum::serve(hook_listener, private).await;
    });
    axum::serve(listener, public)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn channel_and_auth_boundaries() {
        for v in ["../x", "streams/a", "A", "", "a?x"] {
            assert!(!valid_id(v));
        }
        assert!(valid_id("news-1"));
        assert!(equal("secret", "secret"));
        assert!(!equal("secret", "other"));
    }
}
