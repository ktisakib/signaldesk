use super::*;
use tokio::io::AsyncReadExt;

#[derive(Clone)]
pub(crate) struct Segment {
    pub item: PreparedItem,
    pub start: f64,
}

pub(crate) fn next_index(
    items: &[PreparedItem],
    current: &(i64, usize),
    looping: bool,
) -> Option<usize> {
    match items
        .iter()
        .position(|item| (item.id, item.occurrence) == *current)
    {
        Some(i) if i + 1 < items.len() => Some(i + 1),
        Some(_) if !looping => None,
        _ if items.is_empty() => None,
        _ => Some(0),
    }
}

pub(crate) async fn run(
    state: &Arc<AppState>,
    config: &Settings,
    prepared: Vec<PreparedItem>,
    stop: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let (updates, receiver) = watch::channel(prepared);
    {
        let mut runtime = state.runtime.lock().await;
        runtime.live_queue = Some(updates);
        runtime.encoder_clock = 0.;
    }
    let mut args = queue_args(config, std::path::Path::new("pipe:0"));
    let input = args.iter().position(|arg| arg == "-f").unwrap();
    let maps = args.iter().position(|arg| arg == "-map").unwrap();
    let pacing = args.iter().position(|arg| arg == "-re").unwrap();
    args.splice(
        pacing..input,
        [
            "-re".into(),
            "-dts_delta_threshold".into(),
            "0.1".into(),
            "-probesize".into(),
            "18800".into(),
            "-analyzeduration".into(),
            "1".into(),
        ],
    );
    let input = args.iter().position(|arg| arg == "-f").unwrap();
    let maps = args.iter().position(|arg| arg == "-map").unwrap_or(maps);
    args.splice(
        input..maps,
        ["-f".into(), "mpegts".into(), "-i".into(), "pipe:0".into()],
    );
    graphics::apply(state, &mut args);
    let mut child = process("ffmpeg", &state.home)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut pipe = child.stdin.take().ok_or("Missing queue input")?;
    let feeder_state = Arc::clone(state);
    let looping = config.loop_queue;
    let mut feeder_stop = stop.clone();
    let feeder = tokio::spawn(async move {
        let mut current = None;
        let mut clock = 0.;
        let mut buffer = vec![0; 188 * 128];
        loop {
            // Bound look-ahead by program time, even when a low-bitrate clip fits in the OS pipe.
            while clock > feeder_state.runtime.lock().await.encoder_clock + 2.0 {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(40)) => {},
                    _ = feeder_stop.changed() => return Ok::<(), String>(()),
                }
            }
            let items = receiver.borrow().clone();
            let index = match current {
                Some(current) => match next_index(&items, &current, looping) {
                    Some(index) => index,
                    None => break,
                },
                None => 0,
            };
            let Some(item) = items.get(index).cloned() else {
                break;
            };
            {
                let mut runtime = feeder_state.runtime.lock().await;
                runtime.history.push(Segment {
                    item: item.clone(),
                    start: clock,
                });
            }
            let mut file = tokio::fs::File::open(&item.path)
                .await
                .map_err(|e| e.to_string())?;
            loop {
                let size = file.read(&mut buffer).await.map_err(|e| e.to_string())?;
                if size == 0 {
                    break;
                }
                tokio::select! {
                    result = pipe.write_all(&buffer[..size]) => result.map_err(|e| e.to_string())?,
                    _ = feeder_stop.changed() => return Ok::<(), String>(()),
                }
            }
            clock += item.duration;
            current = Some((item.id, item.occurrence));
        }
        Ok(())
    });
    let progress = tokio::spawn(read_progress(
        Arc::clone(state),
        child.stdout.take().unwrap(),
        true,
        config.bitrate_kbps,
        Vec::new(),
    ));
    let log_state = Arc::clone(state);
    let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
    let logger = tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            log_line(&log_state, format!("FFmpeg: {line}")).await
        }
    });
    let result = tokio::select! {
        result = child.wait() => result.map_err(|e| e.to_string()).and_then(|exit| if exit.success() { Ok(()) } else { Err("Queue encoder stopped. Check engine logs.".into()) }),
        _ = stop.changed() => { let _ = child.kill().await; Ok(()) }
    };
    feeder.abort();
    let _ = feeder.await;
    let _ = progress.await;
    let _ = logger.await;
    state.runtime.lock().await.live_queue = None;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_edits_choose_next_occurrence_and_allow_removing_current() {
        let item = |id, occurrence| PreparedItem {
            id,
            occurrence,
            title: String::new(),
            path: PathBuf::new(),
            duration: 1.,
        };
        let queue = vec![item(2, 0), item(1, 0), item(1, 1)];
        assert_eq!(next_index(&queue, &(1, 0), true), Some(2));
        assert_eq!(next_index(&queue, &(1, 1), false), None);
        assert_eq!(next_index(&queue, &(1, 1), true), Some(0));
        assert_eq!(next_index(&queue, &(9, 0), true), Some(0));
        assert_eq!(next_index(&[], &(9, 0), true), None);
    }
}
