#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Request, State},
    http::{header, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{sqlite::SqliteConnectOptions, Row, SqlitePool};
use std::{
    path::PathBuf,
    process::Stdio,
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{watch, Mutex},
    task::JoinHandle,
};
use tower_http::services::{ServeDir, ServeFile};

mod camera;
mod graphics;
mod live_queue;
mod relay;
mod schedule;
mod srt_auth;
mod youtube;

const ADDRESS: &str = "127.0.0.1:9780";
const MAX_UPLOAD_BYTES: usize = 2 * 1024 * 1024 * 1024;
static SHUTDOWN: tokio::sync::Notify = tokio::sync::Notify::const_new();
static UPLOAD_ID: AtomicU64 = AtomicU64::new(0);
type ApiResult<T> = Result<Json<T>, ApiError>;

#[cfg(windows)]
struct ProcessJob(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn process_job() -> Result<ProcessJob, std::io::Error> {
    use windows_sys::Win32::System::{JobObjects::*, Threading::GetCurrentProcess};
    // A crashed or force-terminated engine must not leave encoders holding the streaming ports.
    unsafe {
        let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let job = ProcessJob(handle);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(handle, GetCurrentProcess()) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(job)
    }
}

#[derive(Debug)]
struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        eprintln!("Database error: {error}");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Database operation failed".into(),
        )
    }
}

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    channel_name: String,
    bitrate_kbps: u32,
    public_host: String,
    hls_port: u16,
    rtsp_port: u16,
    loop_queue: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            channel_name: "SignalDesk TV".into(),
            bitrate_kbps: 2500,
            public_host: String::new(),
            hls_port: 8888,
            rtsp_port: 8554,
            loop_queue: true,
        }
    }
}

impl Settings {
    fn validate(&self) -> Result<(), ApiError> {
        if self.channel_name.trim().is_empty() || self.channel_name.len() > 100 {
            return Err(invalid("Channel name must contain 1–100 characters"));
        }
        if !(250..=20000).contains(&self.bitrate_kbps) {
            return Err(invalid("Bitrate must be between 250 and 20000 kbps"));
        }
        if self.hls_port < 1024
            || self.rtsp_port < 1024
            || self.hls_port == self.rtsp_port
            || self.hls_port == 9780
            || self.rtsp_port == 9780
        {
            return Err(invalid(
                "Choose different ports from 1024–65535, excluding control port 9780",
            ));
        }
        if !self.public_host.is_empty() {
            let host = self
                .public_host
                .strip_prefix("https://")
                .map(|host| host.strip_suffix('/').unwrap_or(host))
                .unwrap_or(&self.public_host);
            if host.len() > 253
                || host.split('.').any(|label| {
                    label.is_empty()
                        || label.len() > 63
                        || label.starts_with('-')
                        || label.ends_with('-')
                        || !label
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
                })
            {
                return Err(invalid("Public viewer address must be a hostname/IP, or https://hostname without a port or path"));
            }
        }
        Ok(())
    }

    fn public_hls_url(&self) -> String {
        if self.public_host.is_empty() {
            return String::new();
        }
        if self.public_host.starts_with("https://") {
            format!("{}/live/index.m3u8", self.public_host.trim_end_matches('/'))
        } else {
            format!(
                "http://{}:{}/live/index.m3u8",
                self.public_host, self.hls_port
            )
        }
    }
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct MediaItem {
    id: i64,
    title: String,
    path: String,
    duration_seconds: f64,
    size_bytes: i64,
    width: i64,
    height: i64,
    has_audio: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BroadcastStatus {
    state: String,
    source: Option<String>,
    current_title: Option<String>,
    current_media_id: Option<i64>,
    current_occurrence: usize,
    current_elapsed_seconds: f64,
    current_started_at: Option<String>,
    started_at: Option<String>,
    bitrate_kbps: f64,
    fps: f64,
    viewers: Option<u32>,
    hls_url: String,
    public_url: String,
    error: Option<String>,
    logs: Vec<String>,
}

impl Default for BroadcastStatus {
    fn default() -> Self {
        Self {
            state: "idle".into(),
            source: None,
            current_title: None,
            current_media_id: None,
            current_occurrence: 0,
            current_elapsed_seconds: 0.,
            current_started_at: None,
            started_at: None,
            bitrate_kbps: 0.,
            fps: 0.,
            viewers: None,
            hls_url: String::new(),
            public_url: String::new(),
            error: None,
            logs: Vec::new(),
        }
    }
}

#[derive(Default)]
struct Runtime {
    status: BroadcastStatus,
    stop: Option<watch::Sender<bool>>,
    task: Option<JoinHandle<()>>,
    generation: u64,
    live_queue: Option<watch::Sender<Vec<PreparedItem>>>,
    history: Vec<live_queue::Segment>,
}

struct AppState {
    db: SqlitePool,
    home: PathBuf,
    runtime: Mutex<Runtime>,
    media_server: Mutex<Option<Child>>,
    actions: Mutex<()>,
    queue_preparation: Mutex<()>,
    web_root: Option<PathBuf>,
    bind_address: String,
    camera: Mutex<Option<camera::PendingCamera>>,
    youtube: youtube::YoutubeRelay,
    relay: relay::RemoteRelay,
    graphics: graphics::Graphics,
}

fn data_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("BROADCAST_HOME") {
        return path.into();
    }
    #[cfg(target_os = "windows")]
    let root = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let root = std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library/Application Support"));
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let root = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")));
    root.unwrap_or_else(std::env::temp_dir).join("SignalDesk")
}

fn tool_path(name: &str, home: &std::path::Path) -> PathBuf {
    let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    let bin_dir = std::env::var_os("BROADCAST_BIN_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("runtime/bin"));
    let candidate = bin_dir.join(&file);
    if candidate.is_file() {
        candidate
    } else {
        // Installed Windows services carry verified media tools alongside the engine.
        let bundled = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("bin").join(&file)));
        bundled
            .filter(|path| path.is_file())
            .unwrap_or_else(|| PathBuf::from(file))
    }
}

fn process(name: &str, home: &std::path::Path) -> Command {
    let mut command = Command::new(tool_path(name, home));
    command.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

async fn database(home: &std::path::Path) -> Result<SqlitePool, Box<dyn std::error::Error>> {
    tokio::fs::create_dir_all(home).await?;
    let options = SqliteConnectOptions::from_str("sqlite:")?
        .filename(home.join("studio.sqlite"))
        .create_if_missing(true)
        .foreign_keys(true);
    let db = SqlitePool::connect_with(options).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS media (id INTEGER PRIMARY KEY, title TEXT NOT NULL, path TEXT NOT NULL UNIQUE, duration REAL NOT NULL, size INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, has_audio INTEGER NOT NULL)").execute(&db).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS queue (position INTEGER PRIMARY KEY, media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE)").execute(&db).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL)").execute(&db).await?;
    sqlx::query("INSERT OR IGNORE INTO settings (id,value) VALUES (1,?)")
        .bind(serde_json::to_string(&Settings::default())?)
        .execute(&db)
        .await?;
    Ok(db)
}

async fn settings(state: &AppState) -> Result<Settings, ApiError> {
    let value: String = sqlx::query_scalar("SELECT value FROM settings WHERE id=1")
        .fetch_one(&state.db)
        .await?;
    serde_json::from_str(&value).map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Saved settings are invalid".into(),
        )
    })
}

async fn status(State(state): State<Arc<AppState>>) -> ApiResult<BroadcastStatus> {
    let config = settings(&state).await?;
    let mut result = state.runtime.lock().await.status.clone();
    result.hls_url = format!("http://localhost:{}/live/index.m3u8", config.hls_port);
    result.public_url = config.public_hls_url();
    Ok(Json(result))
}

async fn library_rows(state: &AppState, queue: bool) -> Result<Vec<MediaItem>, ApiError> {
    let query = if queue {
        "SELECT media.* FROM queue JOIN media ON queue.media_id=media.id ORDER BY queue.position"
    } else {
        "SELECT * FROM media ORDER BY id DESC"
    };
    Ok(sqlx::query(query)
        .fetch_all(&state.db)
        .await?
        .iter()
        .map(|row| MediaItem {
            id: row.get("id"),
            title: row.get("title"),
            path: row.get("path"),
            duration_seconds: row.get("duration"),
            size_bytes: row.get("size"),
            width: row.get("width"),
            height: row.get("height"),
            has_audio: row.get("has_audio"),
        })
        .collect())
}

async fn get_library(State(state): State<Arc<AppState>>) -> ApiResult<Vec<MediaItem>> {
    Ok(Json(library_rows(&state, false).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportMedia {
    path: String,
}

async fn import_media(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ImportMedia>,
) -> ApiResult<MediaItem> {
    Ok(Json(
        register_media(&state, PathBuf::from(body.path), None).await?,
    ))
}

async fn register_media(
    state: &AppState,
    path: PathBuf,
    title: Option<String>,
) -> Result<MediaItem, ApiError> {
    if !path.is_absolute() || !path.is_file() {
        return Err(invalid(
            "Choose an existing local video file using its absolute path",
        ));
    }
    let path = tokio::fs::canonicalize(path)
        .await
        .map_err(|e| invalid(e.to_string()))?;
    let size = tokio::fs::metadata(&path)
        .await
        .map_err(|e| invalid(e.to_string()))?
        .len();
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        process("ffprobe", &state.home)
            .args([
                "-v",
                "error",
                "-show_format",
                "-show_streams",
                "-of",
                "json",
            ])
            .arg(&path)
            .output(),
    )
    .await
    .map_err(|_| invalid("FFprobe timed out reading this file"))?
    .map_err(|_| invalid("FFprobe is unavailable. Run the streaming setup first."))?;
    if !output.status.success() {
        return Err(invalid("FFprobe could not read this video file"));
    }
    let probe: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| invalid("Invalid FFprobe output"))?;
    let (duration, width, height, has_audio) = parse_probe(&probe)?;
    let title = title.unwrap_or_else(|| {
        path.file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    });
    let path_text = path.to_string_lossy().to_string();
    sqlx::query("INSERT INTO media (title,path,duration,size,width,height,has_audio) VALUES (?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET title=excluded.title,duration=excluded.duration,size=excluded.size,width=excluded.width,height=excluded.height,has_audio=excluded.has_audio")
        .bind(title).bind(&path_text).bind(duration).bind(size as i64).bind(width).bind(height).bind(has_audio)
        .execute(&state.db).await?;
    let item = library_rows(state, false)
        .await?
        .into_iter()
        .find(|item| item.path == path_text)
        .ok_or_else(|| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Imported media was not saved".into(),
            )
        })?;
    Ok(item)
}

struct PendingUpload {
    path: PathBuf,
    keep: bool,
}

impl Drop for PendingUpload {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn upload_filename(filename: &str) -> Result<String, ApiError> {
    let basename = filename.rsplit(['/', '\\']).next().unwrap_or("");
    let safe: String = basename
        .chars()
        .take(180)
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = safe.trim_matches(['.', ' ']);
    if safe.is_empty() {
        return Err(invalid("Choose a named video file"));
    }
    Ok(safe.to_string())
}

async fn upload_media(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> ApiResult<MediaItem> {
    let mut field = multipart
        .next_field()
        .await
        .map_err(|_| invalid("Invalid video upload"))?
        .ok_or_else(|| invalid("Choose one video file"))?;
    if field.name() != Some("file") {
        return Err(invalid("Video upload must use the file field"));
    }
    let filename = upload_filename(
        field
            .file_name()
            .ok_or_else(|| invalid("Choose a video file"))?,
    )?;
    let directory = state.home.join("uploads");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|_| invalid("Cannot create video upload directory"))?;
    let path = directory.join(format!(
        "{}-{}-{filename}",
        chrono::Utc::now().timestamp_micros(),
        UPLOAD_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .await
        .map_err(|_| invalid("Cannot create uploaded video"))?;
    let mut pending = PendingUpload {
        path: path.clone(),
        keep: false,
    };
    let mut file = file;
    let mut size = 0;
    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|_| invalid("Video upload was interrupted or too large"))?
    {
        size += chunk.len();
        if size > MAX_UPLOAD_BYTES {
            return Err(ApiError(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Videos are limited to 2 GiB each".into(),
            ));
        }
        file.write_all(&chunk)
            .await
            .map_err(|_| invalid("Cannot save uploaded video; check available disk space"))?;
    }
    file.flush()
        .await
        .map_err(|_| invalid("Cannot finish saving uploaded video"))?;
    drop(file);
    drop(field);
    if size == 0
        || multipart
            .next_field()
            .await
            .map_err(|_| invalid("Invalid video upload"))?
            .is_some()
    {
        return Err(invalid("Upload exactly one nonempty video at a time"));
    }
    let title = std::path::Path::new(&filename)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let item = register_media(&state, path, Some(title)).await?;
    pending.keep = true;
    Ok(Json(item))
}

fn parse_probe(probe: &Value) -> Result<(f64, i64, i64, bool), ApiError> {
    let streams = probe["streams"]
        .as_array()
        .ok_or_else(|| invalid("File contains no media streams"))?;
    let video = streams
        .iter()
        .find(|stream| stream["codec_type"] == "video")
        .ok_or_else(|| invalid("Choose a file containing video"))?;
    let duration = probe["format"]["duration"]
        .as_str()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.)
        .ok_or_else(|| invalid("Video must have a finite duration"))?;
    let width = video["width"]
        .as_i64()
        .filter(|v| *v > 0)
        .ok_or_else(|| invalid("Video width is invalid"))?;
    let height = video["height"]
        .as_i64()
        .filter(|v| *v > 0)
        .ok_or_else(|| invalid("Video height is invalid"))?;
    Ok((
        duration,
        width,
        height,
        streams.iter().any(|stream| stream["codec_type"] == "audio"),
    ))
}

async fn delete_media(State(state): State<Arc<AppState>>, Path(id): Path<i64>) -> ApiResult<Value> {
    let _action = state.actions.lock().await;
    if state.runtime.lock().await.stop.is_some() {
        return Err(invalid("Stop the broadcast before removing media"));
    }
    sqlx::query("DELETE FROM media WHERE id=?")
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({"ok": true})))
}

async fn get_queue(State(state): State<Arc<AppState>>) -> ApiResult<Vec<MediaItem>> {
    Ok(Json(library_rows(&state, true).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueueUpdate {
    ids: Vec<i64>,
}

async fn put_queue(
    State(state): State<Arc<AppState>>,
    Json(body): Json<QueueUpdate>,
) -> ApiResult<Vec<MediaItem>> {
    let _action = state.actions.lock().await;
    if body.ids.len() > 1000 {
        return Err(invalid("Queue is limited to 1000 entries"));
    }
    let mut tx = state.db.begin().await?;
    for id in &body.ids {
        let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media WHERE id=?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        if exists == 0 {
            return Err(invalid(format!("Media {id} no longer exists")));
        }
    }
    sqlx::query("DELETE FROM queue").execute(&mut *tx).await?;
    for (position, id) in body.ids.iter().enumerate() {
        sqlx::query("INSERT INTO queue (position,media_id) VALUES (?,?)")
            .bind(position as i64)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    let queue = library_rows(&state, true).await?;
    if let Some(sender) = state.runtime.lock().await.live_queue.clone() {
        let state = Arc::clone(&state);
        let snapshot = queue.clone();
        tokio::spawn(async move {
            let result = async {
                let config = settings(&state).await.map_err(|e| format!("{e:?}"))?;
                let mut stop = state
                    .runtime
                    .lock()
                    .await
                    .stop
                    .as_ref()
                    .ok_or("Broadcast stopped")?
                    .subscribe();
                let prepared = prepare_queue(&state, &config, &snapshot, &mut stop).await?;
                let latest = library_rows(&state, true)
                    .await
                    .map_err(|e| format!("{e:?}"))?;
                if latest
                    .iter()
                    .map(|i| i.id)
                    .eq(snapshot.iter().map(|i| i.id))
                {
                    if let Some(prepared) = prepared {
                        let _ = sender.send(prepared);
                    }
                }
                Ok::<(), String>(())
            }
            .await;
            if let Err(error) = result {
                log_line(&state, format!("Queue update: {error}")).await;
            }
        });
    }
    Ok(Json(queue))
}

async fn get_settings(State(state): State<Arc<AppState>>) -> ApiResult<Settings> {
    Ok(Json(settings(&state).await?))
}

async fn put_settings(
    State(state): State<Arc<AppState>>,
    Json(config): Json<Settings>,
) -> ApiResult<Settings> {
    config.validate()?;
    let _action = state.actions.lock().await;
    if state.runtime.lock().await.stop.is_some() {
        return Err(invalid("Stop the broadcast before changing settings"));
    }
    sqlx::query("UPDATE settings SET value=? WHERE id=1")
        .bind(serde_json::to_string(&config).map_err(|e| invalid(e.to_string()))?)
        .execute(&state.db)
        .await?;
    if let Some(mut server) = state.media_server.lock().await.take() {
        let _ = server.kill().await;
    }
    Ok(Json(config))
}

async fn log_line(state: &AppState, line: String) {
    let mut runtime = state.runtime.lock().await;
    runtime.status.logs.push(line);
    if runtime.status.logs.len() > 80 {
        runtime.status.logs.remove(0);
    }
}

fn media_server_config(settings: &Settings) -> String {
    format!("logLevel: warn\nrtsp: true\nrtspAddress: 127.0.0.1:{}\nrtspTransports: [tcp]\nrtmp: false\nsrt: false\nwebrtc: false\nmoq: false\napi: false\nmetrics: false\npprof: false\nplayback: false\nhls: true\nhlsAddress: :{}\nhlsAllowOrigins: ['*']\nhlsVariant: mpegts\nhlsSegmentCount: 7\nhlsSegmentDuration: 2s\nhlsAlwaysRemux: true\nauthInternalUsers:\n  - user: any\n    ips: ['127.0.0.1', '::1']\n    permissions:\n      - action: publish\n        path: live\n  - user: any\n    permissions:\n      - action: read\n        path: live\npaths:\n  live:\n    source: publisher\n", settings.rtsp_port, settings.hls_port)
}

async fn ensure_media_server(state: &Arc<AppState>, config: &Settings) -> Result<(), ApiError> {
    let mut server = state.media_server.lock().await;
    if let Some(child) = server.as_mut() {
        if child
            .try_wait()
            .map_err(|e| invalid(e.to_string()))?
            .is_none()
        {
            return Ok(());
        }
    }
    for address in [
        format!("127.0.0.1:{}", config.rtsp_port),
        format!("0.0.0.0:{}", config.hls_port),
    ] {
        let listener = tokio::net::TcpListener::bind(&address).await.map_err(|_| {
            invalid(format!(
                "Port at {address} is already in use. Stop the other server or change ports."
            ))
        })?;
        drop(listener);
    }
    let file = state.home.join("mediamtx.yml");
    tokio::fs::write(&file, media_server_config(config))
        .await
        .map_err(|e| invalid(e.to_string()))?;
    let mut child = process("mediamtx", &state.home)
        .arg(file)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| invalid("MediaMTX is unavailable. Run the streaming setup first."))?;
    if let Some(stderr) = child.stderr.take() {
        let state = Arc::clone(state);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log_line(&state, format!("MediaMTX: {line}")).await;
            }
        });
    }
    if let Some(stdout) = child.stdout.take() {
        let state = Arc::clone(state);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log_line(&state, format!("MediaMTX: {line}")).await;
            }
        });
    }
    for _ in 0..50 {
        if let Some(exit) = child.try_wait().map_err(|e| invalid(e.to_string()))? {
            return Err(invalid(format!(
                "MediaMTX exited ({exit}). Check the engine log."
            )));
        }
        if tokio::net::TcpStream::connect(("127.0.0.1", config.rtsp_port))
            .await
            .is_ok()
        {
            *server = Some(child);
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = child.kill().await;
    Err(invalid("MediaMTX did not become ready within five seconds"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartBroadcast {
    source: String,
}

async fn start_broadcast(
    State(state): State<Arc<AppState>>,
    Json(body): Json<StartBroadcast>,
) -> ApiResult<Value> {
    let _action = state.actions.lock().await;
    if body.source != "test" && body.source != "queue" {
        return Err(invalid("Source must be test or queue"));
    }
    if state.runtime.lock().await.stop.is_some() {
        return Err(invalid("A broadcast is already running"));
    }
    launch_program(&state, &body.source).await?;
    Ok(Json(json!({"ok": true})))
}

async fn launch_program(state: &Arc<AppState>, source: &str) -> Result<(), ApiError> {
    let queue = library_rows(state, true).await?;
    if source == "queue" && queue.is_empty() {
        return Err(invalid("Add at least one video to the queue first"));
    }
    let config = settings(state).await?;
    verify_ffmpeg(state).await?;
    state.runtime.lock().await.status.logs.clear();
    ensure_media_server(state, &config).await?;
    let (stop, receiver) = watch::channel(false);
    let mut runtime = state.runtime.lock().await;
    runtime.generation += 1;
    runtime.status.state = "starting".into();
    runtime.status.error = None;
    runtime.status.source = Some(source.to_string());
    runtime.status.started_at = Some(chrono::Utc::now().to_rfc3339());
    runtime.stop = Some(stop);
    runtime.task = Some(tokio::spawn(playout(
        Arc::clone(state),
        config,
        source.to_string(),
        queue,
        receiver,
    )));
    Ok(())
}

async fn verify_ffmpeg(state: &AppState) -> Result<(), ApiError> {
    let ffmpeg = tokio::time::timeout(
        Duration::from_secs(5),
        process("ffmpeg", &state.home).arg("-version").output(),
    )
    .await
    .map_err(|_| invalid("FFmpeg did not respond within five seconds"))?
    .map_err(|_| invalid("FFmpeg is unavailable. Run the streaming setup first."))?;
    if !ffmpeg.status.success() {
        return Err(invalid("FFmpeg failed its startup check"));
    }
    Ok(())
}

fn ffmpeg_args(config: &Settings, item: Option<&MediaItem>) -> Vec<String> {
    let mut args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "warning",
        "-progress",
        "pipe:1",
        "-stats_period",
        "1",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    if let Some(item) = item {
        args.extend(["-re".into(), "-i".into(), item.path.clone()]);
        if !item.has_audio {
            args.extend(
                [
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=channel_layout=stereo:sample_rate=48000",
                ]
                .into_iter()
                .map(String::from),
            );
        }
        args.extend(
            [
                "-map",
                "0:v:0",
                "-map",
                if item.has_audio { "0:a:0" } else { "1:a:0" },
                "-shortest",
            ]
            .into_iter()
            .map(String::from),
        );
    } else {
        args.extend(
            [
                "-re",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=1280x720:rate=25",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000",
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
            ]
            .into_iter()
            .map(String::from),
        );
    }
    args.extend(video_encoding_args(config));
    args.extend(
        [
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-af",
            "apad",
            "-f",
            "rtsp",
            "-rtsp_transport",
            "tcp",
        ]
        .into_iter()
        .map(String::from),
    );
    args.push(format!("rtsp://127.0.0.1:{}/live", config.rtsp_port));
    args
}

fn video_encoding_args(config: &Settings) -> Vec<String> {
    let mut args: Vec<String> = ["-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1", "-r", "25", "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p", "-g", "50", "-keyint_min", "50", "-sc_threshold", "0", "-b:v"].into_iter().map(String::from).collect();
    args.extend([
        format!("{}k", config.bitrate_kbps),
        "-maxrate".into(),
        format!("{}k", config.bitrate_kbps),
        "-bufsize".into(),
        format!("{}k", config.bitrate_kbps * 2),
    ]);
    args
}

fn queue_args(config: &Settings, playlist: &std::path::Path) -> Vec<String> {
    let mut args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "warning",
        "-progress",
        "pipe:1",
        "-stats_period",
        "1",
        "-re",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    if config.loop_queue {
        args.extend(["-stream_loop".into(), "-1".into()]);
    }
    args.extend([
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        playlist.to_string_lossy().to_string(),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "0:a:0".into(),
    ]);
    // One encoder keeps a global GOP; resampling repairs independent clip audio clocks.
    args.extend(video_encoding_args(config));
    args.extend(
        [
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-af",
            "aresample=async=1:first_pts=0",
            "-f",
            "rtsp",
            "-rtsp_transport",
            "tcp",
        ]
        .into_iter()
        .map(String::from),
    );
    args.push(format!("rtsp://127.0.0.1:{}/live", config.rtsp_port));
    args
}

#[derive(Clone)]
struct PreparedItem {
    id: i64,
    occurrence: usize,
    title: String,
    path: PathBuf,
    duration: f64,
}

#[cfg(test)]
fn concat_entry(path: &std::path::Path) -> Result<String, String> {
    let path = path
        .to_str()
        .ok_or("Cache directory must use a Unicode path")?;
    if path.contains(['\n', '\r', '\0']) {
        return Err("Cache directory cannot contain line breaks".into());
    }
    let path = path.replace('\\', "/").replace('\'', "'\\''");
    Ok(format!("file '{path}'\n"))
}

fn preparation_args(config: &Settings, item: &MediaItem, output: &std::path::Path) -> Vec<String> {
    let mut args = ffmpeg_args(config, Some(item));
    args.retain(|arg| arg != "-re");
    args.truncate(args.len() - 5);
    args.extend([
        "-y".into(),
        "-f".into(),
        "mpegts".into(),
        output.to_string_lossy().to_string(),
    ]);
    args
}

async fn read_progress(
    state: Arc<AppState>,
    stdout: tokio::process::ChildStdout,
    publish: bool,
    bitrate: u32,
    timeline: Vec<PreparedItem>,
) {
    let duration: f64 = timeline.iter().map(|item| item.duration).sum();
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some((key, value)) = line.split_once('=') {
            if !publish {
                continue;
            }
            let mut runtime = state.runtime.lock().await;
            if key == "fps" {
                runtime.status.fps = value.trim().parse().unwrap_or(0.);
            }
            if key == "frame" && value.trim().parse::<u64>().unwrap_or(0) > 0 {
                if runtime.status.state != "live" {
                    runtime.status.started_at = Some(chrono::Utc::now().to_rfc3339());
                }
                runtime.status.state = "live".into();
                // RTSP reports no muxed bitrate; this is the configured encoder target.
                runtime.status.bitrate_kbps = bitrate as f64;
            }
            if key == "out_time_us" && !runtime.history.is_empty() {
                let clock = (value.parse::<f64>().unwrap_or(0.) / 1_000_000.).max(0.);
                if let Some(segment) = runtime
                    .history
                    .iter()
                    .rev()
                    .find(|s| s.start <= clock)
                    .cloned()
                {
                    runtime.status.current_title = Some(segment.item.title);
                    runtime.status.current_media_id = Some(segment.item.id);
                    runtime.status.current_occurrence = segment.item.occurrence;
                    runtime.status.current_started_at = Some(
                        (chrono::Utc::now()
                            - chrono::Duration::milliseconds(
                                ((clock - segment.start).max(0.) * 1000.) as i64,
                            ))
                        .to_rfc3339(),
                    );
                    runtime.status.current_elapsed_seconds =
                        (clock - segment.start).min(segment.item.duration);
                    runtime
                        .history
                        .retain(|s| s.start + s.item.duration >= clock - 1.);
                }
            }
            if key == "out_time_us" && duration > 0. {
                let mut position =
                    (value.parse::<f64>().unwrap_or(0.) / 1_000_000.).max(0.) % duration;
                for item in &timeline {
                    if position < item.duration {
                        runtime.status.current_title = Some(item.title.clone());
                        break;
                    }
                    position -= item.duration;
                }
            }
        }
    }
}

async fn run_ffmpeg(
    state: &Arc<AppState>,
    args: Vec<String>,
    stop: &mut watch::Receiver<bool>,
    publish: bool,
    bitrate: u32,
    timeline: Vec<PreparedItem>,
) -> Result<bool, String> {
    if *stop.borrow() {
        return Ok(false);
    }
    let mut args = args;
    if publish {
        graphics::apply(state, &mut args);
    }
    let mut child = process("ffmpeg", &state.home)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start FFmpeg: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("FFmpeg progress pipe is unavailable")?;
    let progress = tokio::spawn(read_progress(
        Arc::clone(state),
        stdout,
        publish,
        bitrate,
        timeline,
    ));
    let stderr = child
        .stderr
        .take()
        .ok_or("FFmpeg log pipe is unavailable")?;
    let log_state = Arc::clone(state);
    let logger = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log_line(&log_state, format!("FFmpeg: {line}")).await;
        }
    });
    let exit = tokio::select! {
        result = child.wait() => Some(result.map_err(|e| e.to_string())?),
        _ = stop.changed() => { let _ = child.kill().await; None }
    };
    let _ = progress.await;
    let _ = logger.await;
    if *stop.borrow() || exit.is_none() {
        return Ok(false);
    }
    if !exit.is_some_and(|status| status.success()) {
        return Err("FFmpeg stopped unexpectedly. Check the engine log.".into());
    }
    Ok(true)
}

async fn prepare_queue(
    state: &Arc<AppState>,
    config: &Settings,
    queue: &[MediaItem],
    stop: &mut watch::Receiver<bool>,
) -> Result<Option<Vec<PreparedItem>>, String> {
    let _preparation = state.queue_preparation.lock().await;
    let cache = state.home.join("cache");
    tokio::fs::create_dir_all(&cache)
        .await
        .map_err(|e| e.to_string())?;
    let mut prepared = Vec::new();
    let mut occurrences = std::collections::HashMap::new();
    for item in queue {
        if *stop.borrow() {
            return Ok(None);
        }
        {
            let mut runtime = state.runtime.lock().await;
            if runtime.status.state == "starting" {
                runtime.status.current_title = Some(format!("Preparing: {}", item.title));
            }
        }
        let metadata = tokio::fs::metadata(&item.path)
            .await
            .map_err(|_| format!("Video is missing: {}", item.title))?;
        let modified = metadata
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let output = cache.join(format!(
            "{}-{}-{modified}-{}.ts",
            item.id,
            metadata.len(),
            config.bitrate_kbps
        ));
        if !output.is_file() {
            let partial = output.with_extension("partial");
            let result = run_ffmpeg(
                state,
                preparation_args(config, item, &partial),
                stop,
                false,
                config.bitrate_kbps,
                Vec::new(),
            )
            .await;
            if !matches!(result, Ok(true)) {
                let _ = tokio::fs::remove_file(partial).await;
                return result.map(|_| None);
            }
            tokio::fs::rename(partial, &output)
                .await
                .map_err(|e| e.to_string())?;
        }
        let probe = tokio::time::timeout(
            Duration::from_secs(10),
            process("ffprobe", &state.home)
                .args([
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "json",
                ])
                .arg(&output)
                .output(),
        )
        .await
        .map_err(|_| "Prepared video probe timed out")?
        .map_err(|e| e.to_string())?;
        let value: Value = serde_json::from_slice(&probe.stdout).map_err(|e| e.to_string())?;
        let duration = value["format"]["duration"]
            .as_str()
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|duration| duration.is_finite() && *duration > 0.)
            .ok_or("Prepared video duration is invalid")?;
        let occurrence = occurrences.entry(item.id).or_insert(0);
        prepared.push(PreparedItem {
            id: item.id,
            occurrence: *occurrence,
            title: item.title.clone(),
            path: output,
            duration,
        });
        *occurrence += 1;
    }
    Ok(Some(prepared))
}

async fn playout(
    state: Arc<AppState>,
    config: Settings,
    source: String,
    queue: Vec<MediaItem>,
    mut stop: watch::Receiver<bool>,
) {
    let result: Result<(), String> = async {
        if source == "test" {
            state.runtime.lock().await.status.current_title =
                Some("Signal test · 720p / 25 fps".into());
            if run_ffmpeg(
                &state,
                ffmpeg_args(&config, None),
                &mut stop,
                true,
                config.bitrate_kbps,
                Vec::new(),
            )
            .await?
            {
                return Err("The test signal stopped unexpectedly".into());
            }
        } else {
            let mut queue = queue;
            let prepared = loop {
                let Some(prepared) = prepare_queue(&state, &config, &queue, &mut stop).await?
                else {
                    return Ok(());
                };
                let latest = library_rows(&state, true)
                    .await
                    .map_err(|e| format!("{e:?}"))?;
                if latest.iter().map(|i| i.id).eq(queue.iter().map(|i| i.id)) {
                    break prepared;
                }
                queue = latest;
            };
            state.runtime.lock().await.history.clear();
            live_queue::run(&state, &config, prepared, &mut stop).await?;
        }
        Ok(())
    }
    .await;
    let mut runtime = state.runtime.lock().await;
    runtime.stop = None;
    runtime.status.fps = 0.;
    runtime.status.bitrate_kbps = 0.;
    runtime.status.current_title = None;
    runtime.status.current_media_id = None;
    runtime.history.clear();
    runtime.status.started_at = None;
    match result {
        Ok(()) => {
            runtime.status.state = "idle".into();
            runtime.status.source = None;
        }
        Err(error) => {
            runtime.status.state = "error".into();
            runtime.status.error = Some(error);
        }
    }
    drop(runtime);
    if !*stop.borrow() {
        youtube::stop(&state).await;
        relay::stop(&state).await;
    }
}

async fn shutdown_for_update(State(state): State<Arc<AppState>>) -> ApiResult<Value> {
    let _action = state.actions.lock().await;
    if state.runtime.lock().await.stop.is_some() {
        return Err(invalid("Stop broadcasting before installing an update"));
    }
    SHUTDOWN.notify_one();
    Ok(Json(json!({"ok": true})))
}

async fn stop_broadcast(State(state): State<Arc<AppState>>) -> ApiResult<Value> {
    let _action = state.actions.lock().await;
    youtube::stop(&state).await;
    relay::stop(&state).await;
    stop_playout(&state).await;
    Ok(Json(json!({"ok": true})))
}

async fn stop_playout(state: &AppState) {
    let task = {
        let mut runtime = state.runtime.lock().await;
        runtime.generation += 1;
        if let Some(stop) = runtime.stop.take() {
            let _ = stop.send(true);
        }
        runtime.task.take()
    };
    if let Some(task) = task {
        let _ = task.await;
    }
    let mut runtime = state.runtime.lock().await;
    runtime.status.state = "idle".into();
    runtime.status.source = None;
    runtime.status.error = None;
    runtime.status.fps = 0.;
    runtime.status.bitrate_kbps = 0.;
    runtime.status.current_title = None;
    runtime.status.started_at = None;
}

async fn tool_status(name: &str, state: &AppState) -> Value {
    match tokio::time::timeout(
        Duration::from_secs(5),
        process(name, &state.home)
            .arg(if name == "mediamtx" {
                "--version"
            } else {
                "-version"
            })
            .output(),
    )
    .await
    {
        Ok(Ok(output)) if output.status.success() => {
            json!({"available": true, "version": String::from_utf8_lossy(&output.stdout).lines().next().unwrap_or("Installed")})
        }
        _ => json!({"available": false, "version": Value::Null}),
    }
}

async fn diagnostics(State(state): State<Arc<AppState>>) -> ApiResult<Value> {
    let (ffmpeg, ffprobe, mediamtx) = tokio::join!(
        tool_status("ffmpeg", &state),
        tool_status("ffprobe", &state),
        tool_status("mediamtx", &state)
    );
    let setup_script = std::env::var_os("BROADCAST_SETUP_SCRIPT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/setup-windows.ps1")
        });
    Ok(Json(
        json!({"ffmpeg": ffmpeg, "ffprobe": ffprobe, "mediamtx": mediamtx, "dataDir": state.home, "controlAddress": state.bind_address, "platform": std::env::consts::OS, "setupScript": setup_script, "webMode": state.web_root.is_some()}),
    ))
}

fn allowed_origin(origin: &str, web_mode: bool) -> bool {
    matches!(
        origin,
        "http://localhost:4321"
            | "http://127.0.0.1:4321"
            | "tauri://localhost"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
    ) || (web_mode
        && matches!(
            origin,
            "http://localhost:8080"
                | "http://127.0.0.1:8080"
                | "http://localhost:9780"
                | "http://127.0.0.1:9780"
        ))
}

async fn local_only(
    State((web_mode, port)): State<(bool, String)>,
    request: Request,
    next: Next,
) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if host != format!("localhost:{port}")
        && host != format!("127.0.0.1:{port}")
        && !matches!(host, "localhost:9780" | "127.0.0.1:9780")
        && !(web_mode && matches!(host, "localhost:8080" | "127.0.0.1:8080"))
    {
        return ApiError(
            StatusCode::FORBIDDEN,
            "Control API accepts localhost requests only".into(),
        )
        .into_response();
    }
    let origin = request.headers().get(header::ORIGIN).cloned();
    if request.uri().path().starts_with("/api/camera/stream/") && origin.is_none() {
        return ApiError(
            StatusCode::FORBIDDEN,
            "Camera streams require an approved dashboard origin".into(),
        )
        .into_response();
    }
    if let Some(origin) = &origin {
        if !origin
            .to_str()
            .is_ok_and(|origin| allowed_origin(origin, web_mode))
        {
            return ApiError(
                StatusCode::FORBIDDEN,
                "This origin cannot control the broadcast".into(),
            )
            .into_response();
        }
    }
    let upload = request.uri().path() == "/api/library/upload" && request.method() == Method::POST;
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim);
    if upload
        && (!web_mode
            || !origin
                .as_ref()
                .is_some_and(|origin| origin.as_bytes() == format!("http://{host}").as_bytes()))
    {
        return ApiError(
            StatusCode::FORBIDDEN,
            "Video uploads require the local web dashboard origin".into(),
        )
        .into_response();
    }
    if matches!(
        *request.method(),
        Method::POST | Method::PUT | Method::DELETE
    ) && if upload {
        content_type != Some("multipart/form-data")
    } else {
        content_type != Some("application/json")
    } {
        return ApiError(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Mutations require application/json".into(),
        )
        .into_response();
    }
    let mut response = if request.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    if let Some(origin) = origin {
        let headers = response.headers_mut();
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.insert(header::VARY, "Origin".parse().unwrap());
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            "GET,POST,PUT,DELETE,OPTIONS".parse().unwrap(),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            "Content-Type".parse().unwrap(),
        );
    }
    response
}

fn router(state: Arc<AppState>) -> Router {
    let mut app = Router::new()
        .nest("/api/camera", camera::router())
        .nest("/api/graphics", graphics::router())
        .nest("/api/youtube", youtube::router())
        .nest("/api/relay", relay::router())
        .nest("/api/schedule", schedule::router())
        .route(
            "/api/health",
            get(|| async {
                Json(json!({"ok":true,"service":"signaldesk","version":env!("CARGO_PKG_VERSION")}))
            }),
        )
        .route("/api/status", get(status))
        .route("/api/library", get(get_library).post(import_media))
        .route(
            "/api/library/upload",
            post(upload_media).layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES + 64 * 1024)),
        )
        .route("/api/library/{id}", axum::routing::delete(delete_media))
        .route("/api/queue", get(get_queue).put(put_queue))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/diagnostics", get(diagnostics))
        .route("/api/system/shutdown", post(shutdown_for_update))
        .route("/api/broadcast/start", post(start_broadcast))
        .route("/api/broadcast/stop", post(stop_broadcast))
        .route("/api", get(|| async { StatusCode::NOT_FOUND }))
        .route("/api/{*path}", get(|| async { StatusCode::NOT_FOUND }));
    if let Some(root) = &state.web_root {
        app = app.fallback_service(
            ServeDir::new(root).not_found_service(ServeFile::new(root.join("index.html"))),
        );
    }
    app.layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn_with_state(
            (
                state.web_root.is_some(),
                state
                    .bind_address
                    .rsplit(':')
                    .next()
                    .unwrap_or("9780")
                    .to_string(),
            ),
            local_only,
        ))
        .with_state(state)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(windows)]
    let _job = process_job()?;
    let bind_address = std::env::var("BROADCAST_BIND").unwrap_or_else(|_| ADDRESS.into());
    let web_root = std::env::var_os("BROADCAST_WEB_ROOT").map(PathBuf::from);
    if web_root
        .as_ref()
        .is_some_and(|root| !root.join("index.html").is_file())
    {
        return Err("BROADCAST_WEB_ROOT must contain the built dashboard index.html".into());
    }
    let listener = tokio::net::TcpListener::bind(&bind_address)
        .await
        .map_err(|e| format!("Cannot bind control port {bind_address}: {e}"))?;
    let home = std::path::absolute(data_dir())?;
    let db = database(&home).await?;
    let state = Arc::new(AppState {
        db,
        home,
        runtime: Mutex::default(),
        media_server: Mutex::default(),
        actions: Mutex::default(),
        queue_preparation: Mutex::default(),
        web_root,
        bind_address,
        camera: Mutex::default(),
        youtube: Default::default(),
        relay: Default::default(),
        graphics: Default::default(),
    });
    println!(
        "SignalDesk engine listening at http://{}; data: {}",
        state.bind_address,
        state.home.display()
    );
    graphics::start(Arc::clone(&state))
        .await
        .map_err(|_| "Cannot initialize broadcast graphics")?;
    tokio::spawn(schedule::run(Arc::clone(&state)));
    let shutdown_state = Arc::clone(&state);
    axum::serve(listener, router(Arc::clone(&state)))
        .with_graceful_shutdown(async move {
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = SHUTDOWN.notified() => {} }
            graphics::stop(&shutdown_state);
            youtube::stop(&shutdown_state).await;
            relay::stop(&shutdown_state).await;
            stop_playout(&shutdown_state).await;
            if let Some(mut child) = shutdown_state.media_server.lock().await.take() {
                let _ = child.kill().await;
            }
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    #[test]
    fn settings_reject_unsafe_or_conflicting_ports_and_hosts() {
        let mut settings = Settings::default();
        assert!(settings.validate().is_ok());
        settings.public_host = "example.com/path\nrtmp: true".into();
        assert!(settings.validate().is_err());
        settings.public_host = "tv.example.com".into();
        assert!(settings.validate().is_ok());
        assert_eq!(
            settings.public_hls_url(),
            "http://tv.example.com:8888/live/index.m3u8"
        );
        settings.public_host = "https://tv.example.com/".into();
        assert!(settings.validate().is_ok());
        assert_eq!(
            settings.public_hls_url(),
            "https://tv.example.com/live/index.m3u8"
        );
        for address in [
            "https://tv.example.com/path",
            "https://tv.example.com:8888",
            "https://user@tv.example.com",
            "https://tv..example.com",
            "http://tv.example.com",
            "https://tv.example.com/?key=secret",
        ] {
            settings.public_host = address.into();
            assert!(settings.validate().is_err(), "{address}");
        }
        settings.public_host = "tv.example.com".into();
        settings.hls_port = settings.rtsp_port;
        assert!(settings.validate().is_err());
    }

    #[test]
    fn probe_requires_finite_video_and_detects_silent_media() {
        let probe = json!({"format":{"duration":"12.5"},"streams":[{"codec_type":"video","width":1920,"height":1080}]});
        assert_eq!(parse_probe(&probe).unwrap(), (12.5, 1920, 1080, false));
        let invalid_probe = json!({"format":{"duration":"NaN"},"streams":[{"codec_type":"video","width":1920,"height":1080}]});
        assert!(parse_probe(&invalid_probe).is_err());
        assert!(parse_probe(&json!({"streams":[{"codec_type":"audio"}]})).is_err());
    }

    #[tokio::test]
    async fn queue_update_rolls_back_for_unknown_media_and_cascades_deletes() {
        let folder = std::env::temp_dir().join(format!("signaldesk-test-{}", std::process::id()));
        let db = database(&folder).await.unwrap();
        sqlx::query("DELETE FROM media").execute(&db).await.unwrap();
        sqlx::query("INSERT INTO media VALUES (1,'Clip','/clip.mp4',10,1000,1280,720,1)")
            .execute(&db)
            .await
            .unwrap();
        let state = Arc::new(AppState {
            db,
            home: folder.clone(),
            runtime: Mutex::default(),
            media_server: Mutex::default(),
            actions: Mutex::default(),
            queue_preparation: Mutex::default(),
            web_root: None,
            bind_address: ADDRESS.into(),
            camera: Mutex::default(),
            youtube: Default::default(),
            relay: Default::default(),
            graphics: Default::default(),
        });
        let _ = put_queue(
            State(Arc::clone(&state)),
            Json(QueueUpdate { ids: vec![1, 1] }),
        )
        .await
        .unwrap();
        assert!(put_queue(
            State(Arc::clone(&state)),
            Json(QueueUpdate { ids: vec![999] })
        )
        .await
        .is_err());
        assert_eq!(library_rows(&state, true).await.unwrap().len(), 2);
        let _ = delete_media(State(Arc::clone(&state)), Path(1))
            .await
            .unwrap();
        assert!(library_rows(&state, true).await.unwrap().is_empty());
        state.db.close().await;
        tokio::fs::remove_dir_all(folder).await.unwrap();
    }

    #[tokio::test]
    async fn local_api_rejects_remote_origins_and_form_mutations() {
        let app = Router::new()
            .route("/", get(|| async { "ok" }).post(|| async { "ok" }))
            .layer(middleware::from_fn_with_state(
                (false, "9780".to_string()),
                local_only,
            ));
        for (origin, host, method, expected) in [
            (
                "https://evil.example",
                "127.0.0.1:9780",
                "GET",
                StatusCode::FORBIDDEN,
            ),
            (
                "http://localhost:4321",
                "evil.example:9780",
                "GET",
                StatusCode::FORBIDDEN,
            ),
            (
                "http://localhost:4321",
                "127.0.0.1:9780",
                "POST",
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
            (
                "http://localhost:4321",
                "127.0.0.1:9780",
                "GET",
                StatusCode::OK,
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/")
                        .method(method)
                        .header(header::HOST, host)
                        .header(header::ORIGIN, origin)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
    }

    #[test]
    fn upload_names_cannot_escape_the_upload_directory() {
        assert_eq!(upload_filename("../../movie.mp4").unwrap(), "movie.mp4");
        assert_eq!(upload_filename("C:\\Videos\\clip.mp4").unwrap(), "clip.mp4");
        assert_eq!(upload_filename("a\n<b>.mp4").unwrap(), "a__b_.mp4");
        assert!(upload_filename("../..").is_err());
    }

    pub(crate) async fn web_test_state(name: &str) -> Arc<AppState> {
        let home = std::env::temp_dir().join(format!("signaldesk-{name}-{}", std::process::id()));
        let db = database(&home).await.unwrap();
        let root = home.join("web");
        tokio::fs::create_dir_all(root.join("assets"))
            .await
            .unwrap();
        tokio::fs::write(root.join("index.html"), "<html>Dashboard</html>")
            .await
            .unwrap();
        tokio::fs::write(root.join("assets/app.js"), "console.log('dashboard')")
            .await
            .unwrap();
        Arc::new(AppState {
            db,
            home,
            runtime: Mutex::default(),
            media_server: Mutex::default(),
            actions: Mutex::default(),
            queue_preparation: Mutex::default(),
            web_root: Some(root),
            bind_address: "0.0.0.0:9780".into(),
            camera: Mutex::default(),
            youtube: Default::default(),
            relay: Default::default(),
            graphics: Default::default(),
        })
    }

    #[tokio::test]
    async fn active_playout_accepts_queue_edits_but_protects_media() {
        let s = web_test_state("active-queue").await;
        let (sender, _) = watch::channel(false);
        s.runtime.lock().await.stop = Some(sender);
        assert!(
            put_queue(State(s.clone()), Json(QueueUpdate { ids: vec![] }))
                .await
                .is_ok()
        );
        assert!(delete_media(State(s.clone()), Path(1)).await.is_err());
        s.runtime.lock().await.stop = None;
        assert!(
            put_queue(State(s.clone()), Json(QueueUpdate { ids: vec![] }))
                .await
                .is_ok()
        );
        let _ = std::fs::remove_dir_all(&s.home);
    }

    #[tokio::test]
    async fn web_dashboard_serves_only_static_assets_and_keeps_unknown_api_routes_404() {
        let state = web_test_state("static").await;
        let app = router(Arc::clone(&state));
        for (path, expected, body) in [
            ("/", StatusCode::OK, "<html>Dashboard</html>"),
            ("/assets/app.js", StatusCode::OK, "console.log('dashboard')"),
            ("/api/missing", StatusCode::NOT_FOUND, ""),
            (
                "/data/studio.sqlite",
                StatusCode::NOT_FOUND,
                "<html>Dashboard</html>",
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .header(header::HOST, "localhost:8080")
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected, "{path}");
            assert_eq!(
                axum::body::to_bytes(response.into_body(), 1024)
                    .await
                    .unwrap()
                    .as_ref(),
                body.as_bytes()
            );
        }
        state.db.close().await;
        tokio::fs::remove_dir_all(&state.home).await.unwrap();
    }

    fn upload_request(body: String, origin: Option<&str>) -> Request {
        let mut request = Request::builder()
            .uri("/api/library/upload")
            .method(Method::POST)
            .header(header::HOST, "localhost:8080")
            .header(
                header::CONTENT_TYPE,
                "multipart/form-data; boundary=signaldesk",
            );
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        request.body(axum::body::Body::from(body)).unwrap()
    }

    fn multipart_video(filename: &str, content: &str, end: bool) -> String {
        format!("--signaldesk\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: video/mp4\r\n\r\n{content}\r\n--signaldesk{}\r\n", if end { "--" } else { "" })
    }

    #[tokio::test]
    async fn uploads_require_same_origin_and_delete_empty_or_incomplete_files() {
        let state = web_test_state("upload-rejected").await;
        let app = router(Arc::clone(&state));
        for origin in [
            None,
            Some("https://evil.example"),
            Some("http://127.0.0.1:8080"),
        ] {
            let response = app
                .clone()
                .oneshot(upload_request(
                    multipart_video("clip.mp4", "video", true),
                    origin,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
        for body in [
            multipart_video("clip.mp4", "", true),
            multipart_video("clip.mp4", "video", false),
        ] {
            let response = app
                .clone()
                .oneshot(upload_request(body, Some("http://localhost:8080")))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert!(tokio::fs::read_dir(state.home.join("uploads"))
                .await
                .unwrap()
                .next_entry()
                .await
                .unwrap()
                .is_none());
        }
        assert!(library_rows(&state, false).await.unwrap().is_empty());
        state.db.close().await;
        tokio::fs::remove_dir_all(&state.home).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn uploads_validate_with_ffprobe_before_saving_a_library_entry() {
        use std::os::unix::fs::PermissionsExt;
        let state = web_test_state("upload-probe").await;
        let bin = state.home.join("runtime/bin");
        tokio::fs::create_dir_all(&bin).await.unwrap();
        let ffprobe = bin.join("ffprobe");
        tokio::fs::write(&ffprobe, "#!/bin/sh\nprintf '%s' '{\"format\":{\"duration\":\"12.5\"},\"streams\":[{\"codec_type\":\"video\",\"width\":1280,\"height\":720}]}'\n").await.unwrap();
        tokio::fs::set_permissions(&ffprobe, std::fs::Permissions::from_mode(0o700))
            .await
            .unwrap();
        let app = router(Arc::clone(&state));
        // A payload above the JSON limit verifies that uploads retain their separate body limit.
        let video = "v".repeat(128 * 1024);
        let response = app
            .clone()
            .oneshot(upload_request(
                multipart_video("../My clip.mp4", &video, true),
                Some("http://localhost:8080"),
            ))
            .await
            .unwrap();
        let response_status = response.status();
        let response_body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(
            response_status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&response_body)
        );
        let media = library_rows(&state, false).await.unwrap();
        assert_eq!(media.len(), 1);
        assert_eq!(media[0].title, "My clip");
        assert_eq!(media[0].size_bytes, video.len() as i64);
        assert!(PathBuf::from(&media[0].path).starts_with(
            tokio::fs::canonicalize(state.home.join("uploads"))
                .await
                .unwrap()
        ));
        assert_eq!(
            tokio::fs::read(&media[0].path).await.unwrap(),
            video.as_bytes()
        );
        tokio::fs::write(&ffprobe, "#!/bin/sh\nexit 1\n")
            .await
            .unwrap();
        let response = app
            .oneshot(upload_request(
                multipart_video("invalid.mp4", "invalid", true),
                Some("http://localhost:8080"),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let mut files = tokio::fs::read_dir(state.home.join("uploads"))
            .await
            .unwrap();
        assert!(files.next_entry().await.unwrap().is_some());
        assert!(files.next_entry().await.unwrap().is_none());
        assert_eq!(library_rows(&state, false).await.unwrap().len(), 1);
        state.db.close().await;
        tokio::fs::remove_dir_all(&state.home).await.unwrap();
    }

    #[test]
    fn encoding_keeps_paths_as_arguments_and_pads_short_audio() {
        let item = MediaItem {
            id: 1,
            title: "Clip".into(),
            path: "/videos/a 'b; c.mp4".into(),
            duration_seconds: 10.,
            size_bytes: 100,
            width: 1280,
            height: 720,
            has_audio: true,
        };
        let args = ffmpeg_args(&Settings::default(), Some(&item));
        assert!(args.windows(2).any(|pair| pair == ["-i", &item.path]));
        assert!(args.windows(2).any(|pair| pair == ["-af", "apad"]));
        assert!(args.windows(2).any(|pair| pair == ["-map", "0:a:0"]));
        let silent = MediaItem {
            has_audio: false,
            ..item
        };
        let args = ffmpeg_args(&Settings::default(), Some(&silent));
        assert!(args.windows(2).any(|pair| pair == ["-map", "1:a:0"]));
        assert!(args.iter().any(|arg| arg.starts_with("anullsrc=")));
    }

    #[test]
    fn concat_paths_escape_quotes_and_reject_line_injection() {
        assert_eq!(
            concat_entry(std::path::Path::new("/cache/a'b.ts")).unwrap(),
            "file '/cache/a'\\''b.ts'\n"
        );
        assert!(concat_entry(std::path::Path::new("/cache/a\nfile '/secret'")).is_err());
        let item = MediaItem {
            id: 1,
            title: "Clip".into(),
            path: "/video.mp4".into(),
            duration_seconds: 10.,
            size_bytes: 100,
            width: 1280,
            height: 720,
            has_audio: false,
        };
        let args = preparation_args(
            &Settings::default(),
            &item,
            std::path::Path::new("/cache/1.partial"),
        );
        assert!(!args.iter().any(|arg| arg == "-re" || arg == "rtsp"));
        assert!(args.windows(2).any(|pair| pair == ["-f", "mpegts"]));
    }

    #[test]
    #[ignore = "requires FFmpeg and FFprobe on PATH"]
    fn queue_boundaries_keep_timestamps_monotonic_and_hls_segments_at_two_seconds() {
        let folder = std::env::temp_dir().join(format!(
            "signaldesk-boundaries-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_micros()
        ));
        std::fs::create_dir_all(&folder).unwrap();
        let encode = |args: Vec<String>| {
            let output = std::process::Command::new("ffmpeg")
                .args(["-hide_banner", "-loglevel", "warning", "-y"])
                .args(args)
                .output()
                .unwrap();
            let logs = String::from_utf8_lossy(&output.stderr).to_lowercase();
            assert!(output.status.success(), "{logs}");
            assert!(
                ![
                    "non-monoton",
                    "backward in time",
                    "out of order",
                    "timestamp discontinuity"
                ]
                .iter()
                .any(|warning| logs.contains(warning)),
                "{logs}"
            );
        };
        let sources = [folder.join("short-audio.mp4"), folder.join("silent.avi")];
        encode(
            [
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x240:rate=30:duration=1.12",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=880:duration=0.44",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
            ]
            .into_iter()
            .map(String::from)
            .chain([sources[0].to_string_lossy().to_string()])
            .collect(),
        );
        encode(
            [
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=640x360:rate=24:duration=1.32",
                "-c:v",
                "mpeg4",
            ]
            .into_iter()
            .map(String::from)
            .chain([sources[1].to_string_lossy().to_string()])
            .collect(),
        );
        let config = Settings::default();
        let mut playlist = "ffconcat version 1.0\n".to_string();
        for (index, source) in sources.iter().enumerate() {
            let cached = folder.join(format!("{index}.ts"));
            let item = MediaItem {
                id: index as i64,
                title: "Boundary fixture".into(),
                path: source.to_string_lossy().to_string(),
                duration_seconds: 2.,
                size_bytes: 0,
                width: 320,
                height: 240,
                has_audio: index == 0,
            };
            encode(preparation_args(&config, &item, &cached));
            playlist.push_str(&concat_entry(&cached).unwrap());
        }
        let input = folder.join("queue.ffconcat");
        std::fs::write(&input, playlist).unwrap();
        let manifest = folder.join("live.m3u8");
        let mut args = queue_args(&config, &input);
        args.retain(|arg| arg != "-re");
        args.truncate(args.len() - 5);
        args.extend(
            [
                "-t",
                "12",
                "-f",
                "hls",
                "-hls_time",
                "2",
                "-hls_list_size",
                "0",
            ]
            .into_iter()
            .map(String::from),
        );
        args.push(manifest.to_string_lossy().to_string());
        encode(args);
        let playlist = std::fs::read_to_string(&manifest).unwrap();
        let durations: Vec<f64> = playlist
            .lines()
            .filter_map(|line| line.strip_prefix("#EXTINF:"))
            .map(|line| line.trim_end_matches(',').parse().unwrap())
            .collect();
        assert_eq!(durations.len(), 6, "{playlist}");
        assert!(
            durations
                .iter()
                .all(|duration| (*duration - 2.).abs() < 0.001),
            "{playlist}"
        );
        let probe = std::process::Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "packet=stream_index,dts_time",
                "-of",
                "json",
            ])
            .arg(&manifest)
            .output()
            .unwrap();
        assert!(
            probe.status.success(),
            "{}",
            String::from_utf8_lossy(&probe.stderr)
        );
        let packets: Value = serde_json::from_slice(&probe.stdout).unwrap();
        let mut last = [None, None];
        for packet in packets["packets"].as_array().unwrap() {
            let stream = packet["stream_index"].as_u64().unwrap() as usize;
            let timestamp: f64 = packet["dts_time"].as_str().unwrap().parse().unwrap();
            if let Some(previous) = last[stream] {
                assert!(
                    timestamp > previous,
                    "Stream {stream} timestamp {timestamp} follows {previous}"
                );
            }
            last[stream] = Some(timestamp);
        }
        assert!(last
            .iter()
            .all(|timestamp| timestamp.is_some_and(|timestamp| timestamp >= 11.9)));
        std::fs::remove_dir_all(folder).unwrap();
    }
}
