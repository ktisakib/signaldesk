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

const SERVER_URL: &str = "rtmps://a.rtmps.youtube.com:443/live2";
const CONFIG_FILE: &str = "youtube.json";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedConfig {
    channel_name: String,
    stream_key: String,
}

impl SavedConfig {
    fn validate(&self) -> Result<(), ApiError> {
        if self.channel_name.trim().is_empty() || self.channel_name.len() > 100 {
            return Err(invalid(
                "YouTube channel name must contain 1–100 characters",
            ));
        }
        if !(16..=256).contains(&self.stream_key.len())
            || !self
                .stream_key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        {
            return Err(invalid(
                "Paste the stream key from YouTube Studio, without a server URL or spaces",
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
    server_url: &'static str,
}

impl From<Option<&SavedConfig>> for PublicConfig {
    fn from(config: Option<&SavedConfig>) -> Self {
        Self {
            channel_name: config.map(|c| c.channel_name.clone()).unwrap_or_default(),
            configured: config.is_some(),
            server_url: SERVER_URL,
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
pub(super) struct YoutubeRelay {
    runtime: Mutex<RelayRuntime>,
}

fn storage_error() -> ApiError {
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Cannot access the saved YouTube connection".into(),
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
        ".youtube-{}-{}.tmp",
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
    stream_key: Option<String>,
}

async fn put_config(
    State(state): State<Arc<AppState>>,
    body: Result<Json<ConfigUpdate>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<PublicConfig> {
    let Json(body) = body.map_err(|_| invalid("Invalid YouTube connection fields"))?;
    let _action = state.actions.lock().await;
    if state.youtube.runtime.lock().await.stop.is_some() {
        return Err(invalid(
            "Stop sending to YouTube before changing the connection",
        ));
    }
    let previous = load(&state.home).await?;
    let config = SavedConfig {
        channel_name: body.channel_name.trim().to_string(),
        stream_key: body
            .stream_key
            .map(|key| key.trim().to_string())
            .or_else(|| previous.map(|config| config.stream_key))
            .ok_or_else(|| invalid("Paste a YouTube stream key first"))?,
    };
    config.validate()?;
    save(&state.home, &config).await?;
    Ok(Json(PublicConfig::from(Some(&config))))
}

async fn clear_config(State(state): State<Arc<AppState>>) -> ApiResult<PublicConfig> {
    let _action = state.actions.lock().await;
    if state.youtube.runtime.lock().await.stop.is_some() {
        return Err(invalid(
            "Stop sending to YouTube before removing the connection",
        ));
    }
    match tokio::fs::remove_file(state.home.join(CONFIG_FILE)).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(storage_error()),
    }
    state.youtube.runtime.lock().await.status = RelayStatus::default();
    Ok(Json(PublicConfig::from(None)))
}

async fn get_status(State(state): State<Arc<AppState>>) -> ApiResult<RelayStatus> {
    Ok(Json(state.youtube.runtime.lock().await.status.clone()))
}

async fn start(State(state): State<Arc<AppState>>) -> ApiResult<Value> {
    let _action = state.actions.lock().await;
    if state.runtime.lock().await.status.state != "live" {
        return Err(invalid(
            "Start the local channel before sending it to YouTube",
        ));
    }
    let config = load(&state.home)
        .await?
        .ok_or_else(|| invalid("Connect a YouTube channel first"))?;
    let port = settings(&state).await?.rtsp_port;
    let mut runtime = state.youtube.runtime.lock().await;
    if runtime.stop.is_some() {
        return Err(invalid("The YouTube output is already active"));
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
        let mut runtime = state.youtube.runtime.lock().await;
        if let Some(stop) = runtime.stop.take() {
            let _ = stop.send(true);
        }
        runtime.task.take()
    };
    if let Some(task) = task {
        let _ = task.await;
    }
    let mut runtime = state.youtube.runtime.lock().await;
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
            "-tls_verify",
            "1",
            "-verifyhost",
            "a.rtmps.youtube.com",
            "-flvflags",
            "no_duration_filesize",
            "-f",
            "flv",
        ]
        .into_iter()
        .map(String::from),
    );
    args.push(format!("{SERVER_URL}/{}", config.stream_key));
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
            let mut runtime = state.youtube.runtime.lock().await;
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
                                let mut runtime = state.youtube.runtime.lock().await;
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
        let mut runtime = state.youtube.runtime.lock().await;
        runtime.status.state = "reconnecting";
        runtime.status.error = Some("YouTube output interrupted. Check the internet connection, stream key, and YouTube Live Control Room.");
        drop(runtime);
        tokio::select! { _ = stop.changed() => {}, _ = tokio::time::sleep(Duration::from_secs(3)) => {} }
    }
}

pub(super) fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/config",
            get(get_config).put(put_config).delete(clear_config),
        )
        .route("/status", get(get_status))
        .route("/start", post(start))
        .route("/stop", post(stop_handler))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::{header, Request},
    };
    use tower::ServiceExt;

    const TEST_KEY: &str = "test-stream-key-12345678";

    #[test]
    fn secrets_cannot_change_the_youtube_host_or_inject_protocol_options() {
        for key in [
            "short",
            "rtmps://evil.example/live/key",
            "test-stream-key-12345678?redirect=evil",
            "test-stream-key-12345678\n",
            "test stream key 12345678",
        ] {
            assert!(SavedConfig {
                channel_name: "Test channel".into(),
                stream_key: key.into()
            }
            .validate()
            .is_err());
        }
        let config = SavedConfig {
            channel_name: "Test channel".into(),
            stream_key: TEST_KEY.into(),
        };
        config.validate().unwrap();
        let args = relay_args(8554, &config);
        let input_index = args.iter().position(|arg| arg == "-i").unwrap();
        assert!(args[..input_index]
            .windows(2)
            .any(|pair| pair == ["-timeout", "10000000"]));
        assert!(!args[..input_index].iter().any(|arg| arg == "-rw_timeout"));
        assert_eq!(
            args.last().unwrap(),
            &format!("rtmps://a.rtmps.youtube.com:443/live2/{TEST_KEY}")
        );
        assert!(args.windows(2).any(|pair| pair == ["-tls_verify", "1"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-verifyhost", "a.rtmps.youtube.com"]));
        assert!(serde_json::from_value::<ConfigUpdate>(
            json!({"channelName":"Test", "streamKey": TEST_KEY, "serverUrl":"rtmp://evil.example"})
        )
        .is_err());
        assert!(!serde_json::to_string(&PublicConfig::from(Some(&config)))
            .unwrap()
            .contains(TEST_KEY));
    }

    async fn request(
        state: &Arc<AppState>,
        path: &str,
        method: &str,
        value: Value,
    ) -> (StatusCode, String) {
        let response = crate::router(Arc::clone(state))
            .oneshot(
                Request::builder()
                    .uri(path)
                    .method(method)
                    .header(header::HOST, "localhost:8080")
                    .header(header::ORIGIN, "http://localhost:8080")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(value.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = String::from_utf8(to_bytes(response.into_body(), 8192).await.unwrap().to_vec())
            .unwrap();
        assert!(
            !body.contains(TEST_KEY),
            "API returned the saved stream key"
        );
        (status, body)
    }

    #[tokio::test]
    async fn connection_persists_privately_never_returns_secret_and_requires_explicit_local_live_start(
    ) {
        let state = crate::tests::web_test_state("youtube-config").await;
        let (status, body) = request(
            &state,
            "/api/youtube/config",
            "PUT",
            json!({"channelName":"NASA test", "streamKey":TEST_KEY}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            load(&state.home).await.unwrap().unwrap().stream_key,
            TEST_KEY
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(state.home.join(CONFIG_FILE))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o077,
                0
            );
        }
        let (status, body) = request(
            &state,
            "/api/youtube/config",
            "PUT",
            json!({"channelName":"Renamed channel"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let saved = load(&state.home).await.unwrap().unwrap();
        assert_eq!(saved.channel_name, "Renamed channel");
        assert_eq!(saved.stream_key, TEST_KEY);
        assert_eq!(
            request(&state, "/api/youtube/config", "GET", json!({}))
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            request(&state, "/api/youtube/status", "GET", json!({}))
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            request(&state, "/api/youtube/start", "POST", json!({}))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        assert!(state.youtube.runtime.lock().await.task.is_none());
        let (status, body) = request(
            &state,
            "/api/youtube/config",
            "PUT",
            json!({"channelName":"Test", "streamKey":1234567890123456_u64}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(!body.contains("1234567890123456"));
        let (sender, _) = watch::channel(false);
        state.youtube.runtime.lock().await.stop = Some(sender);
        assert_eq!(
            request(&state, "/api/youtube/config", "DELETE", json!({}))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            request(
                &state,
                "/api/youtube/config",
                "PUT",
                json!({"channelName":"Cannot change active connection"})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            request(&state, "/api/youtube/stop", "POST", json!({}))
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            request(&state, "/api/youtube/config", "DELETE", json!({}))
                .await
                .0,
            StatusCode::OK
        );
        assert!(load(&state.home).await.unwrap().is_none());
        assert!(!state.home.join(CONFIG_FILE).exists());
        state.db.close().await;
        tokio::fs::remove_dir_all(&state.home).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn relay_reconnects_through_program_switches_and_explicit_stop_cancels_it() {
        use std::os::unix::fs::PermissionsExt;
        let state = crate::tests::web_test_state("youtube-worker").await;
        let bin = state.home.join("runtime/bin");
        tokio::fs::create_dir_all(&bin).await.unwrap();
        let fake = bin.join("ffmpeg");
        tokio::fs::write(
            &fake,
            "#!/bin/sh\nprintf 'out_time_us=1000000\\n'\nexec sleep 30\n",
        )
        .await
        .unwrap();
        tokio::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700))
            .await
            .unwrap();
        // This test must never fall through to a real encoder or contact YouTube.
        assert_eq!(crate::tool_path("ffmpeg", &state.home), fake);
        save(
            &state.home,
            &SavedConfig {
                channel_name: "Local fake encoder".into(),
                stream_key: TEST_KEY.into(),
            },
        )
        .await
        .unwrap();
        state.runtime.lock().await.status.state = "live".into();
        let _ = start(State(Arc::clone(&state))).await.unwrap();
        async fn wait_for(state: &AppState, expected: &str) {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if state.youtube.runtime.lock().await.status.state == expected {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap();
        }
        wait_for(&state, "live").await;
        state.runtime.lock().await.status.state = "starting".into();
        wait_for(&state, "reconnecting").await;
        state.runtime.lock().await.status.state = "live".into();
        wait_for(&state, "live").await;
        stop(&state).await;
        let runtime = state.youtube.runtime.lock().await;
        assert_eq!(runtime.status.state, "idle");
        assert!(runtime.stop.is_none() && runtime.task.is_none());
        drop(runtime);
        assert!(!state
            .runtime
            .lock()
            .await
            .status
            .logs
            .iter()
            .any(|line| line.contains(TEST_KEY)));
        state.db.close().await;
        tokio::fs::remove_dir_all(&state.home).await.unwrap();
    }

    #[test]
    #[ignore = "requires FFmpeg, FFprobe and MediaMTX on PATH; uses only loopback RTSP/RTMP"]
    fn relay_copies_h264_aac_to_a_local_rtmp_receiver() {
        use std::{
            net::TcpListener,
            process::{Child, Command},
            thread,
            time::Instant,
        };
        struct Children(Vec<Child>);
        impl Drop for Children {
            fn drop(&mut self) {
                for child in &mut self.0 {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
        let port = || {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let rtsp_port = port();
        let rtmp_port = port();
        let folder = std::env::temp_dir().join(format!(
            "signaldesk-youtube-local-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_micros()
        ));
        std::fs::create_dir_all(&folder).unwrap();
        let test_log = |name: &str| std::fs::File::create(folder.join(name)).unwrap();
        let media_config = folder.join("mediamtx.yml");
        std::fs::write(&media_config, format!("logLevel: error\nrtspAddress: 127.0.0.1:{rtsp_port}\nrtspTransports: [tcp]\nrtmp: false\nhls: false\nwebrtc: false\nsrt: false\npaths:\n  live:\n    source: publisher\n")).unwrap();
        let mut children = Children(vec![Command::new("mediamtx")
            .arg(media_config)
            .stdout(Stdio::null())
            .stderr(test_log("mediamtx.log"))
            .spawn()
            .unwrap()]);
        let ready = Instant::now();
        while std::net::TcpStream::connect(("127.0.0.1", rtsp_port)).is_err() {
            assert!(
                ready.elapsed() < Duration::from_secs(5),
                "Local MediaMTX did not start"
            );
            thread::sleep(Duration::from_millis(50));
        }
        let input = format!("rtsp://127.0.0.1:{rtsp_port}/live");
        children.0.push(
            Command::new("ffmpeg")
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-re",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=320x240:rate=25",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=sample_rate=48000",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-tune",
                    "zerolatency",
                    "-g",
                    "50",
                    "-c:a",
                    "aac",
                    "-f",
                    "rtsp",
                    "-rtsp_transport",
                    "tcp",
                    &input,
                ])
                .stdout(Stdio::null())
                .stderr(test_log("source.log"))
                .spawn()
                .unwrap(),
        );
        thread::sleep(Duration::from_secs(1));
        let output = folder.join("received.flv");
        let receiver = format!("rtmp://127.0.0.1:{rtmp_port}/live/{TEST_KEY}");
        children.0.push(
            Command::new("ffmpeg")
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-listen",
                    "1",
                    "-timeout",
                    "10",
                    "-i",
                    &receiver,
                    "-t",
                    "3",
                    "-c",
                    "copy",
                ])
                .arg(&output)
                .stdout(Stdio::null())
                .stderr(test_log("receiver.log"))
                .spawn()
                .unwrap(),
        );
        thread::sleep(Duration::from_millis(300));
        let config = SavedConfig {
            channel_name: "Local receiver".into(),
            stream_key: TEST_KEY.into(),
        };
        let mut args = relay_args(rtsp_port, &config);
        // Only this test replaces the fixed production endpoint; no API or env override exists.
        args.pop();
        for option in ["-tls_verify", "-verifyhost"] {
            let index = args.iter().position(|arg| arg == option).unwrap();
            args.drain(index..=index + 1);
        }
        args.extend(["-t".into(), "5".into(), receiver]);
        children.0.push(
            Command::new("ffmpeg")
                .args(args)
                .stdout(Stdio::null())
                .stderr(test_log("relay.log"))
                .spawn()
                .unwrap(),
        );
        let receiver_index = 2;
        let started = Instant::now();
        loop {
            if let Some(status) = children.0[receiver_index].try_wait().unwrap() {
                assert!(
                    status.success(),
                    "Local RTMP receiver failed: receiver={} relay={} source={} mediamtx={}",
                    std::fs::read_to_string(folder.join("receiver.log")).unwrap(),
                    std::fs::read_to_string(folder.join("relay.log")).unwrap(),
                    std::fs::read_to_string(folder.join("source.log")).unwrap(),
                    std::fs::read_to_string(folder.join("mediamtx.log")).unwrap()
                );
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "Local relay did not deliver video"
            );
            thread::sleep(Duration::from_millis(100));
        }
        let probe = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_format",
                "-show_streams",
                "-of",
                "json",
            ])
            .arg(output)
            .output()
            .unwrap();
        assert!(probe.status.success());
        let probe: Value = serde_json::from_slice(&probe.stdout).unwrap();
        let streams = probe["streams"].as_array().unwrap();
        assert!(streams.iter().any(|stream| stream["codec_name"] == "h264"));
        assert!(streams.iter().any(|stream| stream["codec_name"] == "aac"));
        assert!(
            probe["format"]["duration"]
                .as_str()
                .unwrap()
                .parse::<f64>()
                .unwrap()
                >= 2.9
        );
        drop(children);
        std::fs::remove_dir_all(folder).unwrap();
    }
}
