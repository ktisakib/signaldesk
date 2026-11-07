use crate::{invalid, process, settings, ApiError, ApiResult, AppState, PendingUpload};
use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{watch, Mutex},
    task::JoinHandle,
};

const CONFIG_FILE: &str = "relay.json";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedConfig {
    channel_name: String,
    host: String,
    port: u16,
    viewer_url: String,
    stream_key: String,
}

impl SavedConfig {
    fn validate(&self) -> Result<(), ApiError> {
        if !valid_channel(&self.channel_name) {
            return Err(invalid(
                "Use a channel ID with 1–64 lowercase letters, digits or hyphens",
            ));
        }
        if self.host.is_empty()
            || self.host.len() > 253
            || !self
                .host
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-'))
            || self.port == 0
        {
            return Err(invalid(
                "Enter a relay IPv4 address or DNS hostname and valid SRT port",
            ));
        }
        let url = reqwest::Url::parse(&self.viewer_url)
            .map_err(|_| invalid("Enter the relay HTTP or HTTPS base URL"))?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err(invalid(
                "Viewer URL must be an HTTP or HTTPS origin without a path",
            ));
        }
        if !(16..=79).contains(&self.stream_key.len())
            || !self
                .stream_key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        {
            return Err(invalid(
                "Paste the channel publishing key supplied by the relay administrator",
            ));
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicConfig {
    channel_name: String,
    configured: bool,
    host: String,
    port: u16,
    viewer_url: String,
}

impl From<Option<&SavedConfig>> for PublicConfig {
    fn from(config: Option<&SavedConfig>) -> Self {
        Self {
            channel_name: config.map(|c| c.channel_name.clone()).unwrap_or_default(),
            configured: config.is_some(),
            host: config.map(|c| c.host.clone()).unwrap_or_default(),
            port: config.map(|c| c.port).unwrap_or(8890),
            viewer_url: config.map(|c| c.viewer_url.clone()).unwrap_or_default(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayStatus {
    state: &'static str,
    channel_name: String,
    started_at: Option<String>,
    error: Option<&'static str>,
}

impl Default for RelayStatus {
    fn default() -> Self {
        Self {
            state: "idle",
            channel_name: String::new(),
            started_at: None,
            error: None,
        }
    }
}

#[derive(Default)]
struct RelayRuntime {
    status: RelayStatus,
    stop: Option<watch::Sender<bool>>,
    task: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub(super) struct RemoteRelay {
    runtime: Mutex<RelayRuntime>,
}

fn storage_error() -> ApiError {
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Cannot access the saved relay server connection".into(),
    )
}

async fn load(home: &Path) -> Result<Option<SavedConfig>, ApiError> {
    let path = home.join(CONFIG_FILE);
    match tokio::fs::metadata(&path).await {
        Ok(metadata) if metadata.len() > 4096 => return Err(storage_error()),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(storage_error()),
    }
    let bytes = tokio::fs::read(path).await.map_err(|_| storage_error())?;
    let config: SavedConfig = serde_json::from_slice(&bytes).map_err(|_| storage_error())?;
    config.validate().map_err(|_| storage_error())?;
    Ok(Some(config))
}

async fn save(home: &Path, config: &SavedConfig) -> Result<(), ApiError> {
    let temporary = home.join(format!(
        ".relay-{}-{}.tmp",
        std::process::id(),
        chrono::Utc::now().timestamp_micros()
    ));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options
        .open(&temporary)
        .await
        .map_err(|_| storage_error())?;
    let mut pending = PendingUpload {
        path: temporary.clone(),
        keep: false,
    };
    let mut file = file;
    let bytes = serde_json::to_vec(config).map_err(|_| storage_error())?;
    file.write_all(&bytes).await.map_err(|_| storage_error())?;
    file.sync_all().await.map_err(|_| storage_error())?;
    drop(file);
    tokio::fs::rename(temporary, home.join(CONFIG_FILE))
        .await
        .map_err(|_| storage_error())?;
    pending.keep = true;
    Ok(())
}

async fn get_config(State(state): State<Arc<AppState>>) -> ApiResult<PublicConfig> {
    let config = load(&state.home).await?;
    Ok(Json(PublicConfig::from(config.as_ref())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigUpdate {
    channel_name: String,
    host: String,
    port: u16,
    viewer_url: String,
    stream_key: Option<String>,
}

async fn put_config(
    State(state): State<Arc<AppState>>,
    body: Result<Json<ConfigUpdate>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<PublicConfig> {
    let Json(body) = body.map_err(|_| invalid("Invalid relay server connection fields"))?;
    let _action = state.actions.lock().await;
    if state.relay.runtime.lock().await.stop.is_some() {
        return Err(invalid(
            "Stop sending to relay server before changing the connection",
        ));
    }
    let previous = load(&state.home).await?;
    let config = SavedConfig {
        channel_name: body.channel_name.trim().to_string(),
        host: body.host.trim().to_string(),
        port: body.port,
        viewer_url: body.viewer_url.trim().trim_end_matches('/').to_string(),
        stream_key: body
            .stream_key
            .map(|key| key.trim().to_string())
            .or_else(|| previous.map(|config| config.stream_key))
            .ok_or_else(|| invalid("Paste a relay server stream key first"))?,
    };
    config.validate()?;
    save(&state.home, &config).await?;
    Ok(Json(PublicConfig::from(Some(&config))))
}

async fn clear_config(State(state): State<Arc<AppState>>) -> ApiResult<PublicConfig> {
    let _action = state.actions.lock().await;
    if state.relay.runtime.lock().await.stop.is_some() {
        return Err(invalid(
            "Stop sending to relay server before removing the connection",
        ));
    }
    match tokio::fs::remove_file(state.home.join(CONFIG_FILE)).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(storage_error()),
    }
    state.relay.runtime.lock().await.status = RelayStatus::default();
    Ok(Json(PublicConfig::from(None)))
}

async fn get_status(State(state): State<Arc<AppState>>) -> ApiResult<RelayStatus> {
    Ok(Json(state.relay.runtime.lock().await.status.clone()))
}

async fn start(State(state): State<Arc<AppState>>) -> ApiResult<Value> {
    let _action = state.actions.lock().await;
    let protocols = tokio::time::timeout(
        Duration::from_secs(5),
        process("ffmpeg", &state.home)
            .args(["-hide_banner", "-protocols"])
            .output(),
    )
    .await
    .map_err(|_| invalid("FFmpeg protocol check timed out"))?
    .map_err(|_| invalid("FFmpeg is unavailable; install the desktop media tools"))?;
    if !String::from_utf8_lossy(&protocols.stdout)
        .lines()
        .any(|line| line.trim() == "srt")
    {
        return Err(invalid("This FFmpeg build lacks SRT. Install an SRT-enabled FFmpeg build (the Windows setup and Docker runtime include it)."));
    }
    let config = load(&state.home)
        .await?
        .ok_or_else(|| invalid("Connect a relay server channel first"))?;
    let port = settings(&state).await?.rtsp_port;
    let mut runtime = state.relay.runtime.lock().await;
    if runtime.stop.is_some() {
        return Err(invalid("The relay server output is already active"));
    }
    let (stop, receiver) = watch::channel(false);
    runtime.status = RelayStatus {
        state: "connecting",
        channel_name: config.channel_name.clone(),
        started_at: None,
        error: None,
    };
    runtime.stop = Some(stop);
    runtime.task = Some(tokio::spawn(relay(
        Arc::clone(&state),
        port,
        config,
        receiver,
    )));
    Ok(Json(json!({"ok": true})))
}

async fn stop_handler(State(state): State<Arc<AppState>>) -> ApiResult<Value> {
    let _action = state.actions.lock().await;
    stop(&state).await;
    Ok(Json(json!({"ok": true})))
}

pub(super) async fn stop(state: &AppState) {
    let task = {
        let mut runtime = state.relay.runtime.lock().await;
        if let Some(stop) = runtime.stop.take() {
            let _ = stop.send(true);
        }
        runtime.task.take()
    };
    if let Some(task) = task {
        let _ = task.await;
    }
    let mut runtime = state.relay.runtime.lock().await;
    runtime.status.state = "idle";
    runtime.status.started_at = None;
    runtime.status.error = None;
}

fn relay_args(port: u16, config: &SavedConfig) -> Vec<String> {
    let mut args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "warning",
        "-progress",
        "pipe:1",
        "-stats_period",
        "1",
        "-rtsp_transport",
        "tcp",
        "-timeout",
        "10000000",
        "-i",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    args.push(format!("rtsp://127.0.0.1:{port}/live"));
    args.extend(
        [
            "-map",
            "0:v:0",
            "-map",
            "0:a:0",
            "-c",
            "copy",
            "-rw_timeout",
            "10000000",
            "-f",
            "mpegts",
        ]
        .into_iter()
        .map(String::from),
    );
    args.push(format!("srt://{}:{}?mode=caller&streamid=publish:streams/{}:{}:{}&passphrase={}&pbkeylen=32&pkt_size=1316&connect_timeout=5000", config.host, config.port, config.channel_name, config.channel_name, config.stream_key, config.stream_key));
    args
}

async fn relay(
    state: Arc<AppState>,
    port: u16,
    config: SavedConfig,
    mut stop: watch::Receiver<bool>,
) {
    while !*stop.borrow() {
        if state.runtime.lock().await.status.state != "live" {
            let mut runtime = state.relay.runtime.lock().await;
            runtime.status.state = "reconnecting";
            runtime.status.error = Some("Waiting for the local channel to resume");
            drop(runtime);
            tokio::select! { _ = stop.changed() => {}, _ = tokio::time::sleep(Duration::from_millis(500)) => {} }
            continue;
        }
        let child = process("ffmpeg", &state.home)
            .args(relay_args(port, &config))
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        if let Ok(mut child) = child {
            let mut progress =
                BufReader::new(child.stdout.take().expect("piped FFmpeg progress")).lines();
            let mut progress_open = true;
            loop {
                tokio::select! {
                    _ = stop.changed() => { let _ = child.kill().await; break; },
                    _ = child.wait() => break,
                    line = progress.next_line(), if progress_open => {
                        match line {
                            Ok(Some(line)) if line.strip_prefix("out_time_us=").and_then(|value| value.parse::<i64>().ok()).is_some_and(|value| value > 0) => {
                                let mut runtime = state.relay.runtime.lock().await;
                                runtime.status.state = "live";
                                runtime.status.error = None;
                                runtime.status.started_at.get_or_insert_with(|| chrono::Utc::now().to_rfc3339());
                            },
                            Ok(Some(_)) => {},
                            _ => progress_open = false,
                        }
                    },
                    _ = tokio::time::sleep(Duration::from_millis(500)) => {
                        if state.runtime.lock().await.status.state != "live" {
                            let _ = child.kill().await;
                            break;
                        }
                    }
                }
            }
        }
        if *stop.borrow() {
            break;
        }
        let mut runtime = state.relay.runtime.lock().await;
        runtime.status.state = "reconnecting";
        runtime.status.error = Some("Relay output interrupted. Check the server address, UDP publishing port and channel credentials.");
        drop(runtime);
        tokio::select! { _ = stop.changed() => {}, _ = tokio::time::sleep(Duration::from_secs(3)) => {} }
    }
}

async fn test_connection(State(state): State<Arc<AppState>>) -> ApiResult<Value> {
    let config = load(&state.home)
        .await?
        .ok_or_else(|| invalid("Save a relay connection first"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| invalid("Cannot create relay connection"))?;
    let response = client
        .get(format!("{}/api/channels", config.viewer_url))
        .send()
        .await
        .map_err(|_| invalid("Cannot reach the relay web address. Check IP, port and firewall."))?;
    let value: Value = response
        .error_for_status()
        .map_err(|_| invalid("Relay returned an error"))?
        .json()
        .await
        .map_err(|_| invalid("This address is not a SignalDesk relay"))?;
    if !value["channels"]
        .as_array()
        .is_some_and(|items| items.iter().any(|v| v["id"] == config.channel_name))
    {
        return Err(invalid(
            "The assigned channel is not registered on this relay",
        ));
    }
    Ok(Json(
        json!({"ok":true,"message":"Relay reachable and channel registered. Start publishing to verify the SRT port and key."}),
    ))
}

pub(super) fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/config",
            get(get_config).put(put_config).delete(clear_config),
        )
        .route("/status", get(get_status))
        .route("/test", post(test_connection))
        .route("/start", post(start))
        .route("/stop", post(stop_handler))
}

pub(super) fn valid_channel(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_destination_and_keeps_key_out_of_public_config() {
        let mut c = SavedConfig {
            channel_name: "news-a".into(),
            host: "192.168.1.50".into(),
            port: 8890,
            viewer_url: "http://192.168.1.50:8088".into(),
            stream_key: "test-private-key-123456789".into(),
        };
        assert!(c.validate().is_ok());
        let public = serde_json::to_string(&PublicConfig::from(Some(&c))).unwrap();
        assert!(!public.contains(&c.stream_key));
        let args = relay_args(8554, &c);
        assert!(!args.last().unwrap().contains("rw_timeout="));
        assert!(args
            .last()
            .unwrap()
            .contains("streamid=publish:streams/news-a:news-a:"));
        c.host = "host?passphrase=oops".into();
        assert!(c.validate().is_err());
        c.host = "192.168.1.50".into();
        c.channel_name = "../other".into();
        assert!(c.validate().is_err());
        c.channel_name = "news-a".into();
        c.viewer_url = "http://user:secret@host/".into();
        assert!(c.validate().is_err());
    }
}
