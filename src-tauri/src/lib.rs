use std::{path::PathBuf, process::Stdio, time::Duration};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const SERVICE_URL: &str = "http://127.0.0.1:9780";

fn setup_script(app: &tauri::AppHandle) -> PathBuf {
    let bundled = app
        .path()
        .resource_dir()
        .unwrap_or_default()
        .join("runtime/setup-windows.ps1");
    if bundled.is_file() {
        bundled
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/setup-windows.ps1")
    }
}

async fn ensure_service(app: &tauri::AppHandle) -> Result<(), String> {
    static START: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    let _start = START
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    if let Ok(response) = client.get(format!("{SERVICE_URL}/api/health")).send().await {
        if is_engine(response).await {
            return Ok(());
        }
    }
    let file = format!("broadcast-service{}", std::env::consts::EXE_SUFFIX);
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut candidates = vec![executable
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join(&file)];
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("runtime").join(&file));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../target/debug")
            .join(&file),
    );
    let service = candidates.into_iter().find(|path| path.is_file()).ok_or(
        "Broadcast engine is missing. Run npm run service:build before opening the desktop app.",
    )?;
    let mut command = std::process::Command::new(service);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("BROADCAST_SETUP_SCRIPT", setup_script(app));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x00000008 | 0x00000200);
    }
    command
        .spawn()
        .map_err(|e| format!("Could not start the broadcast engine: {e}"))?;
    for _ in 0..50 {
        if let Ok(response) = client.get(format!("{SERVICE_URL}/api/health")).send().await {
            if is_engine(response).await {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("The broadcast engine did not start. Check whether port 9780 is already in use.".into())
}

async fn is_engine(response: reqwest::Response) -> bool {
    response.status().is_success()
        && response
            .json::<serde_json::Value>()
            .await
            .is_ok_and(|body| body["ok"] == true && body["service"] == "signaldesk")
}

#[tauri::command]
async fn api_request(
    app: tauri::AppHandle,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "DELETE")
        || !path.starts_with("/api/")
        || path.contains("..")
        || path.contains(['?', '#', '\\'])
    {
        return Err("Invalid local API request".into());
    }
    ensure_service(&app).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(40))
        .build()
        .map_err(|e| e.to_string())?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut request = client
        .request(method, format!("{SERVICE_URL}{path}"))
        .header("Content-Type", "application/json");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("Engine request failed: {e}"))?;
    let status = response.status();
    let mut value: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Invalid engine response: {e}"))?;
    if !status.is_success() {
        return Err(value["error"]
            .as_str()
            .unwrap_or("Engine request failed")
            .to_string());
    }
    if path == "/api/diagnostics" {
        value["setupScript"] = setup_script(&app).to_string_lossy().to_string().into();
    }
    Ok(value)
}

#[tauri::command]
async fn pick_media(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(
            "Video",
            &[
                "mp4", "mkv", "mov", "avi", "ts", "m4v", "webm", "mpeg", "mpg",
            ],
        )
        .pick_file(move |file| {
            let _ = send.send(file.map(|file| file.to_string()));
        });
    receive.await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_media_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(
            "Video",
            &[
                "mp4", "mkv", "mov", "avi", "ts", "m4v", "webm", "mpeg", "mpg",
            ],
        )
        .pick_files(move |files| {
            let _ = send.send(
                files
                    .unwrap_or_default()
                    .into_iter()
                    .map(|f| f.to_string())
                    .collect(),
            );
        });
    receive.await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    Ok(match update {
        Some(update) => serde_json::json!({ "version": update.version, "notes": update.body }),
        None => serde_json::Value::Null,
    })
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("No update is available")?;
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{SERVICE_URL}/api/system/shutdown"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err("Stop the broadcast before installing the update".into());
    }
    for _ in 0..40 {
        if client
            .get(format!("{SERVICE_URL}/api/health"))
            .send()
            .await
            .is_err()
        {
            update.install(bytes).map_err(|e| e.to_string())?;
            app.restart();
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err("Engine is still shutting down. Retry the update.".into())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            api_request,
            pick_media,
            pick_media_files,
            check_update,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("Unable to run the SignalDesk desktop app");
}
