use super::*;
use axum::extract::{
    ws::{Message, WebSocket, WebSocketUpgrade},
    Path,
};
use tokio::sync::oneshot;

const MAX_MESSAGE: usize = 4 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const DATA_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) struct PendingCamera {
    id: String,
    socket: oneshot::Sender<WebSocket>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CameraStart {
    title: String,
    mime_type: String,
    return_to_queue: bool,
    has_audio: bool,
}

impl CameraStart {
    fn format(&self) -> Result<&'static str, ApiError> {
        if self.title.trim().is_empty() || self.title.len() > 100 {
            return Err(invalid("Camera title must contain 1–100 characters"));
        }
        if self.mime_type.len() > 200 {
            return Err(invalid("Camera MIME type is too long"));
        }
        match self.mime_type.split(';').next().map(str::trim) {
            Some("video/webm") => Ok("webm"),
            Some("video/mp4") => Ok("mp4"),
            _ => Err(invalid(
                "Camera must use MediaRecorder WebM or fragmented MP4 video",
            )),
        }
    }
}

pub(super) fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/start", post(start))
        .route("/stream/{id}", get(connect))
        .route("/return", post(return_to_queue))
}

async fn start(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CameraStart>,
) -> ApiResult<Value> {
    request.format()?;
    let _action = state.actions.lock().await;
    {
        let runtime = state.runtime.lock().await;
        if runtime.status.source.as_deref() == Some("camera") && runtime.stop.is_some() {
            return Err(invalid("A camera session is already active"));
        }
    }
    if request.return_to_queue && library_rows(&state, true).await?.is_empty() {
        return Err(invalid(
            "Add videos to the queue or disable return to queue",
        ));
    }
    let config = settings(&state).await?;
    verify_ffmpeg(&state).await?;
    ensure_media_server(&state, &config).await?;
    stop_playout(&state).await;
    let id = uuid::Uuid::new_v4().to_string();
    let (send_socket, receive_socket) = oneshot::channel();
    *state.camera.lock().await = Some(PendingCamera {
        id: id.clone(),
        socket: send_socket,
    });
    let (send_stop, stop) = watch::channel(false);
    let mut runtime = state.runtime.lock().await;
    runtime.generation += 1;
    let generation = runtime.generation;
    runtime.status = BroadcastStatus {
        state: "starting".into(),
        source: Some("camera".into()),
        current_title: Some(request.title.clone()),
        ..Default::default()
    };
    runtime.stop = Some(send_stop);
    runtime.task = Some(tokio::spawn(session(
        Arc::clone(&state),
        id.clone(),
        generation,
        request,
        config,
        receive_socket,
        stop,
    )));
    Ok(Json(
        json!({"sessionId":id,"webSocketPath":format!("/api/camera/stream/{id}")}),
    ))
}

async fn connect(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let mut pending = state.camera.lock().await;
    if !pending.as_ref().is_some_and(|camera| camera.id == id) {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Camera session is missing or already connected".into(),
        ));
    }
    let camera = pending
        .take()
        .ok_or_else(|| invalid("Camera session is already connected"))?;
    Ok(ws
        .max_message_size(MAX_MESSAGE)
        .max_frame_size(MAX_MESSAGE)
        .on_upgrade(move |socket| async move {
            let _ = camera.socket.send(socket);
        }))
}

async fn return_to_queue(State(state): State<Arc<AppState>>) -> ApiResult<Value> {
    let _action = state.actions.lock().await;
    if library_rows(&state, true).await?.is_empty() {
        return Err(invalid("The saved queue is empty"));
    }
    let already_queue = {
        let runtime = state.runtime.lock().await;
        runtime.status.source.as_deref() == Some("queue") && runtime.stop.is_some()
    };
    if !already_queue {
        stop_playout(&state).await;
        launch_program(&state, "queue").await?;
    }
    Ok(Json(json!({"ok":true})))
}

fn camera_args(config: &Settings, format: &str, has_audio: bool) -> Vec<String> {
    let mut args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "warning",
        "-progress",
        "pipe:1",
        "-stats_period",
        "1",
        "-thread_queue_size",
        "32",
        "-protocol_whitelist",
        "pipe",
        "-f",
        format,
        "-i",
        "pipe:0",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    if !has_audio {
        args.extend(
            [
                "-re",
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
            if has_audio { "0:a:0" } else { "1:a:0" },
        ]
        .into_iter()
        .map(String::from),
    );
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

async fn send(socket: &mut WebSocket, message: Value) -> Result<(), String> {
    tokio::time::timeout(
        Duration::from_secs(2),
        socket.send(Message::Text(message.to_string().into())),
    )
    .await
    .map_err(|_| "Camera control connection stalled")?
    .map_err(|_| "Camera disconnected".into())
}

async fn encode(
    state: &Arc<AppState>,
    mut socket: WebSocket,
    config: &Settings,
    format: &str,
    has_audio: bool,
    stop: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let mut args = camera_args(config, format, has_audio);
    crate::graphics::apply(state, &mut args);
    let mut child = process("ffmpeg", &state.home)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start camera encoder: {error}"))?;
    let mut input = child
        .stdin
        .take()
        .ok_or("Camera encoder input is unavailable")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Camera progress pipe is unavailable")?;
    let progress = tokio::spawn(read_progress(
        Arc::clone(state),
        stdout,
        true,
        config.bitrate_kbps,
        Vec::new(),
    ));
    let stderr = child
        .stderr
        .take()
        .ok_or("Camera log pipe is unavailable")?;
    let log_state = Arc::clone(state);
    let logger = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log_line(&log_state, format!("Camera FFmpeg: {line}")).await;
        }
    });
    let result = async {
        send(&mut socket, json!({"type":"ready"})).await?;
        let mut last_data = tokio::time::Instant::now();
        loop {
            let message = tokio::select! {
                _ = stop.changed() => return Ok(()),
                result = child.wait() => return Err(format!("Camera encoder exited: {}", result.map_err(|error| error.to_string())?)),
                _ = tokio::time::sleep_until(last_data + DATA_TIMEOUT) => return Err("Camera stopped sending video for ten seconds".into()),
                message = socket.recv() => message,
            };
            match message {
                Some(Ok(Message::Binary(data))) => {
                    if data.is_empty() || data.len() > MAX_MESSAGE { return Err("Camera chunks must contain 1 byte to 4 MiB".into()); }
                    tokio::time::timeout(WRITE_TIMEOUT, input.write_all(&data)).await
                        .map_err(|_| "Camera encoder input stalled")?.map_err(|_| "Camera encoder input closed")?;
                    last_data = tokio::time::Instant::now();
                    send(&mut socket, json!({"type":"ack","bytes":data.len()})).await?;
                }
                Some(Ok(Message::Close(_))) | None => return Ok(()),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {},
                Some(Ok(Message::Text(_))) => return Err("Camera streams accept binary video chunks only".into()),
                Some(Err(_)) => return Err("Camera transport disconnected".into()),
            }
        }
    }.await;
    if let Err(error) = &result {
        let _ = send(&mut socket, json!({"type":"error","message":error})).await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), socket.send(Message::Close(None))).await;
    drop(input);
    let _ = child.kill().await;
    let _ = progress.await;
    let _ = logger.await;
    result
}

async fn session(
    state: Arc<AppState>,
    id: String,
    generation: u64,
    request: CameraStart,
    config: Settings,
    connection: oneshot::Receiver<WebSocket>,
    mut stop: watch::Receiver<bool>,
) {
    let result: Result<(), String> = async {
        let format = request.format().map_err(|error| error.1)?;
        let socket = tokio::select! {
            _ = stop.changed() => return Ok(()),
            connection = tokio::time::timeout(CONNECT_TIMEOUT, connection) => connection
                .map_err(|_| "Camera did not connect within fifteen seconds")?
                .map_err(|_| "Camera connection was cancelled")?,
        };
        encode(
            &state,
            socket,
            &config,
            format,
            request.has_audio,
            &mut stop,
        )
        .await
    }
    .await;
    {
        let mut pending = state.camera.lock().await;
        if pending.as_ref().is_some_and(|pending| pending.id == id) {
            pending.take();
        }
    }
    {
        let mut runtime = state.runtime.lock().await;
        runtime.stop = None;
        runtime.status.state = if result.is_err() {
            "error".into()
        } else {
            "idle".into()
        };
        runtime.status.error = result.err();
        if runtime.status.error.is_none() {
            runtime.status.source = None;
        }
        runtime.status.fps = 0.;
        runtime.status.bitrate_kbps = 0.;
        runtime.status.current_title = None;
        runtime.status.started_at = None;
    }
    // Fallback cannot await the actions lock inside the task that Stop is joining.
    tokio::spawn(async move {
        let _action = state.actions.lock().await;
        if *stop.borrow() || state.runtime.lock().await.generation != generation {
            return;
        }
        if request.return_to_queue {
            if let Err(error) = launch_program(&state, "queue").await {
                let mut runtime = state.runtime.lock().await;
                runtime.status.state = "error".into();
                runtime.status.error = Some(error.1);
                drop(runtime);
                youtube::stop(&state).await;
            }
        } else {
            youtube::stop(&state).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    #[tokio::test]
    #[ignore = "requires FFmpeg, FFprobe and MediaMTX; uses synthetic input, never camera hardware"]
    async fn generated_webm_audio_and_mp4_silent_camera_reach_hls_and_return_to_queue() {
        use futures_util::{SinkExt, StreamExt};
        use tokio::io::AsyncReadExt;
        use tokio_tungstenite::{
            connect_async,
            tungstenite::{client::IntoClientRequest, Message as ClientMessage},
        };
        let state = crate::tests::web_test_state("camera-real").await;
        let free_port = || {
            std::net::TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port()
        };
        let config = Settings {
            hls_port: free_port(),
            rtsp_port: free_port(),
            ..Default::default()
        };
        let _ = put_settings(State(Arc::clone(&state)), Json(config.clone()))
            .await
            .unwrap();
        let fallback = state.home.join("fallback.mp4");
        let output = process("ffmpeg", &state.home)
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x240:rate=25:duration=3",
                "-c:v",
                "libx264",
            ])
            .arg(&fallback)
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let item = import_media(
            State(Arc::clone(&state)),
            Json(ImportMedia {
                path: fallback.to_string_lossy().to_string(),
            }),
        )
        .await
        .unwrap()
        .0;
        let _ = put_queue(
            State(Arc::clone(&state)),
            Json(QueueUpdate { ids: vec![item.id] }),
        )
        .await
        .unwrap();
        launch_program(&state, "queue").await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server_state = Arc::clone(&state);
        let server = tokio::spawn(async move {
            axum::serve(listener, crate::router(server_state))
                .await
                .unwrap();
        });
        for (format, has_audio) in [("webm", true), ("mp4", false)] {
            let response = start(
                State(Arc::clone(&state)),
                Json(CameraStart {
                    title: format!("Generated {format}"),
                    mime_type: format!("video/{format}"),
                    return_to_queue: true,
                    has_audio,
                }),
            )
            .await
            .unwrap()
            .0;
            let mut request = format!(
                "ws://{address}{}",
                response["webSocketPath"].as_str().unwrap()
            )
            .into_client_request()
            .unwrap();
            request
                .headers_mut()
                .insert("Host", "localhost:9780".parse().unwrap());
            request
                .headers_mut()
                .insert("Origin", "http://localhost:4321".parse().unwrap());
            let (mut socket, _) = connect_async(request).await.unwrap();
            let ready = socket.next().await.unwrap().unwrap().into_text().unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&ready).unwrap()["type"],
                "ready"
            );
            let mut args: Vec<String> = [
                "-v",
                "error",
                "-re",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x240:rate=25",
            ]
            .into_iter()
            .map(String::from)
            .collect();
            if has_audio {
                args.extend(
                    ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"]
                        .into_iter()
                        .map(String::from),
                );
            }
            args.extend(["-t", "30"].into_iter().map(String::from));
            if format == "webm" {
                args.extend(
                    [
                        "-c:v",
                        "libvpx",
                        "-deadline",
                        "realtime",
                        "-cpu-used",
                        "8",
                        "-g",
                        "25",
                        "-c:a",
                        "libopus",
                        "-cluster_time_limit",
                        "500",
                        "-live",
                        "1",
                    ]
                    .into_iter()
                    .map(String::from),
                );
            } else {
                args.extend(
                    [
                        "-c:v",
                        "libx264",
                        "-preset",
                        "ultrafast",
                        "-g",
                        "25",
                        "-movflags",
                        "frag_keyframe+empty_moov+default_base_moof",
                        "-frag_duration",
                        "500000",
                    ]
                    .into_iter()
                    .map(String::from),
                );
            }
            args.extend(["-f".into(), format.into(), "pipe:1".into()]);
            let mut producer = process("ffmpeg", &state.home)
                .args(args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let mut stream = producer.stdout.take().unwrap();
            let (cancel_feed, mut cancelled) = watch::channel(false);
            let feed = tokio::spawn(async move {
                let mut data = vec![0; 16 * 1024];
                loop {
                    let size = tokio::select! { _=cancelled.changed()=>break, size=stream.read(&mut data)=>size.unwrap() };
                    if size == 0 {
                        break;
                    }
                    if socket
                        .send(ClientMessage::Binary(data[..size].to_vec().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                    let ack = tokio::time::timeout(Duration::from_secs(6), socket.next()).await;
                    if !matches!(ack, Ok(Some(Ok(ClientMessage::Text(_))))) {
                        break;
                    }
                }
                let _ = socket.close(None).await;
                let _ = producer.kill().await;
            });
            tokio::time::timeout(Duration::from_secs(18), async {
                loop {
                    let status = state.runtime.lock().await.status.clone();
                    assert_ne!(status.state, "error", "{:?}", status.logs);
                    if status.state == "live" && status.source.as_deref() == Some("camera") {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            })
            .await
            .expect("Camera never became live");
            let decoded = tokio::time::timeout(
                Duration::from_secs(18),
                process("ffmpeg", &state.home)
                    .args([
                        "-v",
                        "warning",
                        "-xerror",
                        "-i",
                        &format!("http://127.0.0.1:{}/live/index.m3u8", config.hls_port),
                        "-t",
                        "4",
                        "-map",
                        "0:v:0",
                        "-map",
                        "0:a:0",
                        "-f",
                        "null",
                        "-",
                    ])
                    .output(),
            )
            .await
            .unwrap()
            .unwrap();
            assert!(
                decoded.status.success(),
                "{}",
                String::from_utf8_lossy(&decoded.stderr)
            );
            if format == "mp4" {
                let _ = return_to_queue(State(Arc::clone(&state))).await.unwrap();
            }
            let _ = cancel_feed.send(true);
            feed.await.unwrap();
            tokio::time::timeout(Duration::from_secs(12), async {
                loop {
                    let runtime = state.runtime.lock().await;
                    if runtime.status.state == "live"
                        && runtime.status.source.as_deref() == Some("queue")
                    {
                        break;
                    }
                    drop(runtime);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            })
            .await
            .expect("Camera did not return to the saved queue");
            assert_eq!(library_rows(&state, true).await.unwrap()[0].id, item.id);
        }
        let _ = stop_broadcast(State(Arc::clone(&state))).await.unwrap();
        server.abort();
        if let Some(mut child) = state.media_server.lock().await.take() {
            let _ = child.kill().await;
        }
        state.db.close().await;
        tokio::fs::remove_dir_all(&state.home).await.unwrap();
    }

    #[tokio::test]
    async fn stop_during_pending_camera_does_not_wait_for_the_actions_lock() {
        let state = crate::tests::web_test_state("camera-stop").await;
        let action = state.actions.lock().await;
        let (send_socket, socket) = oneshot::channel();
        let (send_stop, stop) = watch::channel(false);
        let request = CameraStart {
            title: "Camera".into(),
            mime_type: "video/webm".into(),
            return_to_queue: true,
            has_audio: false,
        };
        let mut runtime = state.runtime.lock().await;
        runtime.generation = 1;
        runtime.stop = Some(send_stop);
        runtime.task = Some(tokio::spawn(session(
            Arc::clone(&state),
            "test".into(),
            1,
            request,
            Settings::default(),
            socket,
            stop,
        )));
        drop(runtime);
        tokio::time::timeout(Duration::from_secs(1), stop_playout(&state))
            .await
            .unwrap();
        drop(action);
        drop(send_socket);
        tokio::task::yield_now().await;
        assert_eq!(state.runtime.lock().await.status.state, "idle");
        assert!(state.runtime.lock().await.stop.is_none());
        state.db.close().await;
        tokio::fs::remove_dir_all(&state.home).await.unwrap();
    }

    #[test]
    fn validates_formats_and_keeps_camera_input_bounded_to_stdin() {
        let mut request = CameraStart {
            title: "Studio camera".into(),
            mime_type: "video/webm;codecs=vp8,opus".into(),
            return_to_queue: false,
            has_audio: true,
        };
        assert_eq!(request.format().unwrap(), "webm");
        request.mime_type = "video/mp4;codecs=avc1.42E01E,mp4a.40.2".into();
        assert_eq!(request.format().unwrap(), "mp4");
        request.mime_type = "http://evil.example/camera".into();
        assert!(request.format().is_err());
        let args = camera_args(&Settings::default(), "webm", false);
        assert!(args.windows(2).any(|pair| pair == ["-i", "pipe:0"]));
        assert!(args.windows(2).any(|pair| pair == ["-map", "1:a:0"]));
        assert!(args.windows(2).any(|pair| pair == ["-g", "50"]));
    }

    #[tokio::test]
    async fn websocket_requires_origin_and_session_and_rejects_empty_fallback_queue() {
        let state = crate::tests::web_test_state("camera-security").await;
        let app = crate::router(Arc::clone(&state));
        let missing_origin = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/camera/stream/no-session")
                    .header(header::HOST, "localhost:8080")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing_origin.status(), StatusCode::FORBIDDEN);
        let request = Request::builder().uri("/api/camera/start").method(Method::POST)
            .header(header::HOST,"localhost:8080").header(header::CONTENT_TYPE,"application/json")
            .header(header::ORIGIN,"http://localhost:8080")
            .body(axum::body::Body::from(r#"{"title":"Camera","mimeType":"video/webm","returnToQueue":true,"hasAudio":false}"#)).unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(state.runtime.lock().await.status.state, "idle");
        state.db.close().await;
        tokio::fs::remove_dir_all(&state.home).await.unwrap();
    }
}
