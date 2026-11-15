use super::*;
use axum::{
    body::{Body, Bytes},
    extract::Query,
    http::{header, Response},
    response::IntoResponse,
};
use futures_util::StreamExt;
use serde::Serialize;
use std::{collections::HashMap, net::IpAddr};
use tokio::time::Instant;

#[derive(Default)]
pub(super) struct Limits {
    clocks: Mutex<HashMap<String, Instant>>,
    requests: Arc<std::sync::Mutex<HashMap<String, usize>>>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(super) struct Policy {
    pub domain: String,
    pub enabled: bool,
    pub max_readers: u32,
    pub egress_mbps: u32,
    pub ingest_mbps: u32,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            domain: String::new(),
            enabled: true,
            max_readers: 100,
            egress_mbps: 100,
            ingest_mbps: 10,
        }
    }
}
pub(super) fn domain(value: &str) -> bool {
    value.len() <= 253
        && value.contains('.')
        && value.parse::<IpAddr>().is_err()
        && value.split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        })
}
impl Policy {
    pub fn validate(&self) -> Result<(), (StatusCode, &'static str)> {
        if (!self.domain.is_empty() && !domain(&self.domain))
            || !(1..=10000).contains(&self.max_readers)
            || !(1..=10000).contains(&self.egress_mbps)
            || !(1..=1000).contains(&self.ingest_mbps)
        {
            return Err((StatusCode::BAD_REQUEST, "Use a lowercase DNS hostname, 1–10000 HLS sessions/output Mbps, and 1–1000 ingest Mbps"));
        }
        Ok(())
    }
}
pub(super) fn parse_policy(value: &str) -> Policy {
    serde_json::from_str(value).unwrap_or_default()
}
pub(super) async fn migrate(db: &SqlitePool) -> Result<(), sqlx::Error> {
    let columns = sqlx::query("PRAGMA table_info(channels)")
        .fetch_all(db)
        .await?;
    if !columns
        .iter()
        .any(|r| r.get::<String, _>("name") == "policy")
    {
        sqlx::query("ALTER TABLE channels ADD COLUMN policy TEXT NOT NULL DEFAULT '{}'")
            .execute(db)
            .await?;
    }
    sqlx::query("CREATE TABLE IF NOT EXISTS platform(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)").execute(db).await?;
    Ok(())
}
pub(super) async fn policy(app: &App, id: &str) -> Result<Policy, (StatusCode, &'static str)> {
    let row = sqlx::query("SELECT policy FROM channels WHERE id=?")
        .bind(id)
        .fetch_optional(&app.db)
        .await
        .map_err(|_| failure())?
        .ok_or((StatusCode::NOT_FOUND, "Channel not found"))?;
    Ok(parse_policy(&row.get::<String, _>("policy")))
}
pub(super) async fn ensure_domain_available(
    app: &App,
    id: &str,
    domain: &str,
) -> Result<(), (StatusCode, &'static str)> {
    if domain.is_empty() {
        return Ok(());
    }
    let settings = read_settings(app).await?;
    if domain == settings.admin_domain {
        return Err((StatusCode::CONFLICT, "Domain belongs to administration"));
    }
    for row in sqlx::query("SELECT id,policy FROM channels WHERE id<>?")
        .bind(id)
        .fetch_all(&app.db)
        .await
        .map_err(|_| failure())?
    {
        if parse_policy(&row.get::<String, _>("policy")).domain == domain {
            return Err((StatusCode::CONFLICT, "Domain already assigned"));
        }
    }
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Settings {
    public_host: String,
    srt_port: u16,
    public_web_url: String,
    admin_domain: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            public_host: "103.140.205.192".into(),
            srt_port: 8890,
            public_web_url: "http://103.140.205.192:18088".into(),
            admin_domain: String::new(),
        }
    }
}
async fn read_settings(app: &App) -> Result<Settings, (StatusCode, &'static str)> {
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM platform WHERE id=1")
        .fetch_optional(&app.db)
        .await
        .map_err(|_| failure())?;
    value
        .map(|s| serde_json::from_str(&s).map_err(|_| failure()))
        .unwrap_or(Ok(Settings::default()))
}
pub(super) async fn settings(State(app): State<Arc<App>>) -> Reply {
    Ok(Json(
        serde_json::to_value(read_settings(&app).await?).map_err(|_| failure())?,
    ))
}
pub(super) async fn save_settings(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(body): Json<Settings>,
) -> Reply {
    authorize(&app, &headers)?;
    let _lock = app.changes.lock().await;
    let url = reqwest::Url::parse(&body.public_web_url)
        .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid public web URL"))?;
    if (body.public_host.parse::<IpAddr>().is_err() && !domain(&body.public_host))
        || body.srt_port == 0
        || !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || (!body.admin_domain.is_empty() && !domain(&body.admin_domain))
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Use a valid publishing host, port, web origin and optional DNS domain",
        ));
    }
    if !body.admin_domain.is_empty() {
        for row in sqlx::query("SELECT policy FROM channels")
            .fetch_all(&app.db)
            .await
            .map_err(|_| failure())?
        {
            if parse_policy(&row.get::<String, _>("policy")).domain == body.admin_domain {
                return Err((StatusCode::CONFLICT, "Domain already belongs to a channel"));
            }
        }
    }
    sqlx::query("INSERT INTO platform(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
        .bind(serde_json::to_string(&body).map_err(|_|failure())?).execute(&app.db).await.map_err(|_|failure())?;
    Ok(Json(json!({"ok":true})))
}
pub(super) async fn admin_channels(State(app): State<Arc<App>>, headers: HeaderMap) -> Reply {
    authorize(&app, &headers)?;
    channels(State(app)).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Update {
    name: String,
    policy: Policy,
}
pub(super) async fn update(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Update>,
) -> Reply {
    authorize(&app, &headers)?;
    body.policy.validate()?;
    if !valid_id(&id)
        || body.name.trim().is_empty()
        || body.name.len() > 100
        || body.name.chars().any(char::is_control)
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid channel ID or name"));
    }
    let _lock = app.changes.lock().await;
    ensure_domain_available(&app, &id, &body.policy.domain).await?;
    let secret: String = sqlx::query_scalar("SELECT secret FROM channels WHERE id=?")
        .bind(&id)
        .fetch_optional(&app.db)
        .await
        .map_err(|_| failure())?
        .ok_or((StatusCode::NOT_FOUND, "Channel not found"))?;
    let old = policy(&app, &id).await?;
    // MediaMTX restarts a path when maxReaders changes; metadata and bandwidth edits stay live.
    if body.policy.enabled && !old.enabled {
        app.client
            .post(format!("{}/v3/config/paths/add/streams/{id}", app.media))
            .json(
                &json!({"source":"publisher","overridePublisher":false,"record":false,
                "srtPublishPassphrase":secret,"maxReaders":body.policy.max_readers}),
            )
            .send()
            .await
            .map_err(|_| failure())?
            .error_for_status()
            .map_err(|_| failure())?;
    } else if body.policy.enabled && old.max_readers != body.policy.max_readers {
        app.client
            .patch(format!("{}/v3/config/paths/patch/streams/{id}", app.media))
            .json(&json!({"maxReaders":body.policy.max_readers}))
            .send()
            .await
            .map_err(|_| failure())?
            .error_for_status()
            .map_err(|_| failure())?;
    } else if !body.policy.enabled && old.enabled {
        remove_media(&app, &id).await?;
    }
    if sqlx::query("UPDATE channels SET name=?,policy=? WHERE id=?")
        .bind(body.name.trim())
        .bind(serde_json::to_string(&body.policy).map_err(|_| failure())?)
        .bind(&id)
        .execute(&app.db)
        .await
        .is_err()
    {
        let _ = remove_media(&app, &id).await;
        let _ = media_path(&app, &id, &secret).await;
        return Err(failure());
    }
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
pub(super) struct TlsQuery {
    domain: String,
}
pub(super) async fn allow_tls(
    State(app): State<Arc<App>>,
    Query(query): Query<TlsQuery>,
) -> StatusCode {
    if !domain(&query.domain) {
        return StatusCode::FORBIDDEN;
    }
    if read_settings(&app)
        .await
        .is_ok_and(|s| s.admin_domain == query.domain)
    {
        return StatusCode::NO_CONTENT;
    }
    match sqlx::query("SELECT policy FROM channels")
        .fetch_all(&app.db)
        .await
    {
        Ok(rows)
            if rows.iter().any(|r| {
                let p = parse_policy(&r.get::<String, _>("policy"));
                p.enabled && p.domain == query.domain
            }) =>
        {
            StatusCode::NO_CONTENT
        }
        _ => StatusCode::FORBIDDEN,
    }
}
struct Guard {
    id: String,
    requests: Arc<std::sync::Mutex<HashMap<String, usize>>>,
}
impl Drop for Guard {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.requests.lock() {
            if let Some(count) = requests.get_mut(&self.id) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    requests.remove(&self.id);
                }
            }
        }
    }
}
pub(super) async fn stream(
    State(app): State<Arc<App>>,
    Path((id, file)): Path<(String, String)>,
    headers: HeaderMap,
    uri: axum::http::Uri,
) -> axum::response::Response {
    proxy(app, id, file, headers, uri)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}
pub(super) async fn domain_stream(
    State(app): State<Arc<App>>,
    Path(file): Path<String>,
    headers: HeaderMap,
    uri: axum::http::Uri,
) -> axum::response::Response {
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    let rows = sqlx::query("SELECT id,policy FROM channels")
        .fetch_all(&app.db)
        .await;
    if let Ok(rows) = rows {
        if let Some(row) = rows
            .iter()
            .find(|r| parse_policy(&r.get::<String, _>("policy")).domain == host)
        {
            return proxy(app, row.get("id"), file, headers, uri)
                .await
                .unwrap_or_else(IntoResponse::into_response);
        }
    }
    StatusCode::NOT_FOUND.into_response()
}
async fn proxy(
    app: Arc<App>,
    id: String,
    file: String,
    headers: HeaderMap,
    uri: axum::http::Uri,
) -> Result<axum::response::Response, (StatusCode, &'static str)> {
    if !valid_id(&id)
        || file.is_empty()
        || file.len() > 200
        || file.starts_with('.')
        || file.contains("..")
        || !file
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid stream path"));
    }
    let policy = policy(&app, &id).await?;
    if !policy.enabled {
        return Err((StatusCode::FORBIDDEN, "Channel disabled"));
    }
    // Bound simultaneous HTTP requests as well as MediaMTX's HLS viewer sessions.
    {
        let mut counts = app.limits.requests.lock().map_err(|_| failure())?;
        let count = counts.entry(id.clone()).or_default();
        if *count >= policy.max_readers as usize * 4 {
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                "Channel request limit reached",
            ));
        }
        *count += 1;
    }
    let guard = Guard {
        id: id.clone(),
        requests: Arc::clone(&app.limits.requests),
    };
    let mut url = reqwest::Url::parse(&app.hls).map_err(|_| failure())?;
    url.set_path(&format!("/streams/{id}/{file}"));
    url.set_query(uri.query());
    let mut request = app.streaming.get(url);
    if let Some(cookie) = headers.get(header::COOKIE) {
        request = request.header(header::COOKIE, cookie);
    }
    let response = request.send().await.map_err(|_| failure())?;
    let status = response.status();
    let mut builder = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    for name in [header::CONTENT_TYPE, header::LOCATION, header::SET_COOKIE] {
        for value in response.headers().get_all(&name) {
            builder = builder.header(&name, value);
        }
    }
    let upstream = response.bytes_stream();
    let body = futures_util::stream::unfold(
        (upstream, app, id, guard, Bytes::new()),
        move |(mut upstream, app, id, guard, mut pending)| async move {
            if pending.is_empty() {
                match upstream.next().await {
                    Some(Ok(bytes)) => pending = bytes,
                    Some(Err(error)) => {
                        return Some((
                            Err(std::io::Error::other(error)),
                            (upstream, app, id, guard, pending),
                        ))
                    }
                    None => return None,
                }
            }
            let bytes = pending.split_to(pending.len().min(16384));
            let current = match self::policy(&app, &id).await {
                Ok(p) if p.enabled => p,
                _ => return None,
            };
            let delay = {
                let mut clocks = app.limits.clocks.lock().await;
                let next = clocks.entry(id.clone()).or_insert_with(Instant::now);
                let start = (*next).max(Instant::now());
                *next = start
                    + Duration::from_secs_f64(
                        bytes.len() as f64 * 8. / (current.egress_mbps as f64 * 1_000_000.),
                    );
                start
            };
            tokio::time::sleep_until(delay).await;
            Some((
                Ok::<_, std::io::Error>(bytes),
                (upstream, app, id, guard, pending),
            ))
        },
    );
    builder.body(Body::from_stream(body)).map_err(|_| failure())
}
pub(super) async fn monitor(app: Arc<App>) {
    let mut previous: HashMap<String, (u64, Instant)> = HashMap::new();
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let result = app
            .client
            .get(format!("{}/v3/paths/list", app.media))
            .send()
            .await;
        let Ok(response) = result else { continue };
        let Ok(value) = response.json::<Value>().await else {
            continue;
        };
        let Some(paths) = value["items"].as_array() else {
            continue;
        };
        for path in paths {
            let Some(id) = path["name"]
                .as_str()
                .and_then(|p| p.strip_prefix("streams/"))
            else {
                continue;
            };
            let Ok(policy) = policy(&app, id).await else {
                continue;
            };
            let bytes = path["inboundBytes"]
                .as_u64()
                .or_else(|| path["bytesReceived"].as_u64())
                .unwrap_or(0);
            let now = Instant::now();
            let exceeded = previous
                .insert(id.into(), (bytes, now))
                .is_some_and(|(old, time)| {
                    bytes >= old
                        && (bytes - old) as f64 * 8. / now.duration_since(time).as_secs_f64()
                            > policy.ingest_mbps as f64 * 1_000_000.
                });
            if exceeded || !policy.enabled {
                if let Some(source) = path["source"]["id"].as_str() {
                    let _ = app
                        .client
                        .post(format!("{}/v3/srt/conns/kick/{source}", app.media))
                        .send()
                        .await;
                }
            }
        }
        previous.retain(|id, _| paths.iter().any(|p| p["name"] == format!("streams/{id}")));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policies_validate_domains_and_finite_limits() {
        for value in [
            "https://news.example.com",
            "*.example.com",
            "example.com:443",
            "-x.example.com",
            "127.0.0.1",
            "a..com",
            "example.com/",
        ] {
            assert!(!domain(value));
        }
        assert!(domain("news.example.com"));
        let old = parse_policy("{}");
        assert!(old.enabled);
        assert_eq!(old.max_readers, 100);
        let mut policy = old;
        policy.max_readers = 0;
        assert!(policy.validate().is_err());
    }
}

#[cfg(test)]
mod integration {
    use super::*;
    async fn fixture() -> (Arc<App>, tokio::task::JoinHandle<()>) {
        let mock = Router::new()
            .route(
                "/streams/{id}/{*file}",
                get(|| async {
                    (
                        [(header::CONTENT_TYPE, "video/mp2t")],
                        vec![7u8; 512 * 1024],
                    )
                }),
            )
            .fallback(|| async { Json(json!({"items":[]})) });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, mock).await.unwrap();
        });
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,secret TEXT NOT NULL)",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO channels VALUES('legacy','Legacy','saved-secret')")
            .execute(&db)
            .await
            .unwrap();
        migrate(&db).await.unwrap();
        migrate(&db).await.unwrap();
        (
            Arc::new(App {
                db,
                admin: "test-admin-token".into(),
                hook: "test-hook-token".into(),
                media: origin.clone(),
                hls: origin,
                client: reqwest::Client::new(),
                streaming: reqwest::Client::new(),
                changes: Mutex::new(()),
                limits: Limits::default(),
            }),
            task,
        )
    }
    fn admin() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            "Bearer test-admin-token".parse().unwrap(),
        );
        headers
    }
    #[tokio::test]
    async fn migration_and_admin_domain_policies_preserve_credentials() {
        let (app, task) = fixture().await;
        assert_eq!(policy(&app, "legacy").await.unwrap().max_readers, 100);
        let secret: String = sqlx::query_scalar("SELECT secret FROM channels WHERE id='legacy'")
            .fetch_one(&app.db)
            .await
            .unwrap();
        assert_eq!(secret, "saved-secret");
        let body = NewChannel {
            id: "news".into(),
            name: "News".into(),
            policy: Policy {
                domain: "news.example.com".into(),
                max_readers: 2,
                ..Policy::default()
            },
        };
        assert_eq!(
            create(State(app.clone()), HeaderMap::new(), Json(body))
                .await
                .unwrap_err()
                .0,
            StatusCode::UNAUTHORIZED
        );
        let body = NewChannel {
            id: "news".into(),
            name: "News".into(),
            policy: Policy {
                domain: "news.example.com".into(),
                max_readers: 2,
                ..Policy::default()
            },
        };
        let _ = create(State(app.clone()), admin(), Json(body))
            .await
            .unwrap();
        assert_eq!(
            ensure_domain_available(&app, "legacy", "news.example.com")
                .await
                .unwrap_err()
                .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            allow_tls(
                State(app.clone()),
                Query(TlsQuery {
                    domain: "news.example.com".into()
                })
            )
            .await,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            allow_tls(
                State(app.clone()),
                Query(TlsQuery {
                    domain: "other.example.com".into()
                })
            )
            .await,
            StatusCode::FORBIDDEN
        );
        let mut disabled = policy(&app, "news").await.unwrap();
        disabled.enabled = false;
        let _ = update(
            State(app.clone()),
            admin(),
            Path("news".into()),
            Json(Update {
                name: "Updated".into(),
                policy: disabled,
            }),
        )
        .await
        .unwrap();
        let result = proxy(
            app.clone(),
            "news".into(),
            "index.m3u8".into(),
            HeaderMap::new(),
            "/streams/news/index.m3u8".parse().unwrap(),
        )
        .await;
        assert_eq!(result.unwrap_err().0, StatusCode::FORBIDDEN);
        assert_eq!(
            auth(
                State(app.clone()),
                Path(app.hook.clone()),
                Json(Auth {
                    user: "".into(),
                    password: "".into(),
                    action: "read".into(),
                    path: "streams/news".into(),
                    protocol: "hls".into()
                })
            )
            .await,
            StatusCode::FORBIDDEN
        );
        task.abort();
    }
    #[tokio::test]
    async fn bandwidth_is_shared_across_requests_and_unassigned_domains_are_denied() {
        let (app, task) = fixture().await;
        let p = Policy {
            egress_mbps: 1,
            ..Policy::default()
        };
        let _ = update(
            State(app.clone()),
            admin(),
            Path("legacy".into()),
            Json(Update {
                name: "Legacy".into(),
                policy: p,
            }),
        )
        .await
        .unwrap();
        let start = Instant::now();
        let read = || async {
            let response = proxy(
                app.clone(),
                "legacy".into(),
                "seg.ts".into(),
                HeaderMap::new(),
                "/streams/legacy/seg.ts".parse().unwrap(),
            )
            .await
            .unwrap();
            let data = axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap();
            assert_eq!(data.len(), 512 * 1024);
        };
        tokio::join!(read(), read());
        assert!(
            start.elapsed() >= Duration::from_millis(7800),
            "Aggregate rate cap was bypassed"
        );
        assert!(app.limits.requests.lock().unwrap().is_empty());
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "unknown.example.com".parse().unwrap());
        assert_eq!(
            domain_stream(
                State(app.clone()),
                Path("index.m3u8".into()),
                headers,
                "/live/index.m3u8".parse().unwrap()
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        task.abort();
    }
    #[tokio::test]
    async fn admin_requires_tls_on_public_hosts_and_the_correct_secret() {
        let (app, task) = fixture().await;
        let mut headers = admin();
        headers.insert(header::HOST, "103.140.205.192:18088".parse().unwrap());
        headers.insert("x-forwarded-proto", "http".parse().unwrap());
        assert_eq!(
            authorize(&app, &headers).unwrap_err().0,
            StatusCode::FORBIDDEN
        );
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        assert!(authorize(&app, &headers).is_ok());
        headers.insert(header::AUTHORIZATION, "Bearer wrong".parse().unwrap());
        assert_eq!(
            authorize(&app, &headers).unwrap_err().0,
            StatusCode::UNAUTHORIZED
        );
        task.abort();
    }
}
