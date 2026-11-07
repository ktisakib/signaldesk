use crate::{invalid, ApiError, ApiResult, AppState};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use resvg::{tiny_skia, usvg};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

const WIDTH: u32 = 1280;
const HEIGHT: u32 = 720;
const MAX_LOGO: usize = 2 * 1024 * 1024;
#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Config {
    pub enabled: bool,
    pub lower_third_enabled: bool,
    pub lower_title: String,
    pub lower_subtitle: String,
    pub ticker_enabled: bool,
    pub banner_label: String,
    pub ticker_text: String,
    pub ticker_speed: u32,
    pub logo_enabled: bool,
    pub logo_corner: String,
    pub logo_width: u32,
    pub logo_data_url: Option<String>,
    pub accent: String,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            lower_third_enabled: false,
            lower_title: "Presenter name".into(),
            lower_subtitle: "Correspondent".into(),
            ticker_enabled: false,
            banner_label: "BREAKING NEWS".into(),
            ticker_text: "Enter the latest headlines, announcements or job advertisements here."
                .into(),
            ticker_speed: 85,
            logo_enabled: false,
            logo_corner: "right".into(),
            logo_width: 120,
            logo_data_url: None,
            accent: "#e32636".into(),
        }
    }
}
impl Config {
    fn validate(&self) -> Result<(), ApiError> {
        for (value, max) in [
            (&self.lower_title, 90),
            (&self.lower_subtitle, 150),
            (&self.banner_label, 32),
            (&self.ticker_text, 2000),
        ] {
            if value.chars().count() > max || value.chars().any(|c| c.is_control()) {
                return Err(invalid(
                    "Graphics text is too long or contains control characters",
                ));
            }
        }
        if !(30..=180).contains(&self.ticker_speed)
            || !(64..=240).contains(&self.logo_width)
            || !matches!(self.logo_corner.as_str(), "left" | "right")
        {
            return Err(invalid("Choose a valid ticker speed, logo size and corner"));
        }
        if self.accent.len() != 7
            || !self.accent.starts_with('#')
            || !self.accent[1..].bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(invalid("Choose a valid accent color"));
        }
        if self.lower_third_enabled && self.lower_title.trim().is_empty() {
            return Err(invalid("Enter a lower-third title"));
        }
        if self.ticker_enabled
            && (self.banner_label.trim().is_empty() || self.ticker_text.trim().is_empty())
        {
            return Err(invalid("Enter the banner label and ticker text"));
        }
        if self.logo_enabled && self.logo_data_url.is_none() {
            return Err(invalid("Choose a PNG channel logo first"));
        }
        if let Some(data) = &self.logo_data_url {
            validate_logo(data)?;
        }
        Ok(())
    }
    fn visible(&self) -> bool {
        self.enabled && (self.lower_third_enabled || self.ticker_enabled || self.logo_enabled)
    }
}
fn validate_logo(data: &str) -> Result<(), ApiError> {
    let encoded = data
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| invalid("Channel logos must be PNG images"))?;
    if encoded.len() > MAX_LOGO * 4 / 3 + 8 {
        return Err(invalid("Choose a PNG logo up to 2 MiB"));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| invalid("Invalid logo data"))?;
    if bytes.len() < 24
        || bytes.len() > MAX_LOGO
        || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
        || &bytes[12..16] != b"IHDR"
    {
        return Err(invalid("Invalid PNG logo"));
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let h = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if w == 0 || h == 0 || w > 1024 || h > 1024 {
        return Err(invalid("Logo dimensions must be between 1 and 1024 pixels"));
    }
    tiny_skia::Pixmap::decode_png(&bytes).map_err(|_| invalid("Cannot decode this PNG logo"))?;
    Ok(())
}
struct Visual {
    config: Arc<Config>,
    previous: Arc<Config>,
    changed: Instant,
    epoch: Instant,
    frame: Vec<u8>,
    error: Option<String>,
}
pub(super) struct Graphics {
    inner: Mutex<Visual>,
    stopped: AtomicBool,
}
impl Default for Graphics {
    fn default() -> Self {
        let c = Arc::new(Config::default());
        Self {
            inner: Mutex::new(Visual {
                config: c.clone(),
                previous: c,
                changed: Instant::now(),
                epoch: Instant::now(),
                frame: Vec::new(),
                error: None,
            }),
            stopped: AtomicBool::new(false),
        }
    }
}
fn fonts() -> Arc<usvg::fontdb::Database> {
    static DB: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();
    DB.get_or_init(|| {
        let mut db = usvg::fontdb::Database::new();
        db.load_font_data(include_bytes!("../assets/fonts/NotoSans-Regular.ttf").to_vec());
        db.load_font_data(include_bytes!("../assets/fonts/NotoSansBengali-Regular.ttf").to_vec());
        db.set_sans_serif_family("Noto Sans");
        Arc::new(db)
    })
    .clone()
}
fn options() -> usvg::Options<'static> {
    usvg::Options {
        font_family: "Noto Sans".into(),
        fontdb: fonts(),
        ..Default::default()
    }
}
fn xml(v: &str) -> String {
    v.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn text_width(text: &str, size: u32) -> f32 {
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="50000" height="100"><text x="0" y="60" font-family="Noto Sans, Noto Sans Bengali" font-size="{size}">{}</text></svg>"##,
        xml(text)
    );
    usvg::Tree::from_str(&svg, &options())
        .map(|t| t.root().abs_bounding_box().width())
        .unwrap_or(1000.)
}
fn render(config: &Config, previous: &Config, age: f64, time: f64) -> Result<Vec<u8>, String> {
    let mut svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}"><defs><clipPath id="ticker"><rect x="285" y="654" width="995" height="66"/></clipPath><clipPath id="lower"><rect x="70" y="530" width="860" height="108"/></clipPath><clipPath id="label"><rect x="18" y="654" width="250" height="66"/></clipPath></defs>"##
    );
    let showing = config.enabled && config.lower_third_enabled;
    let leaving = !showing && previous.enabled && previous.lower_third_enabled && age < 0.45;
    if showing || leaving {
        let p = (age / 0.45).clamp(0., 1.);
        let ease = 1. - (1. - p).powi(3);
        let x = if showing {
            -(1. - ease) * 970.
        } else {
            -ease * 970.
        };
        let c = if showing { config } else { previous };
        svg.push_str(&format!(r##"<g transform="translate({x} 0)"><rect x="48" y="530" width="900" height="108" rx="3" fill="#101820" fill-opacity=".94"/><rect x="48" y="530" width="10" height="108" fill="{}"/><g clip-path="url(#lower)"><text x="80" y="574" fill="white" font-family="Noto Sans, Noto Sans Bengali" font-size="32">{}</text><text x="80" y="611" fill="#d5dce4" font-family="Noto Sans, Noto Sans Bengali" font-size="21">{}</text></g></g>"##,c.accent,xml(&c.lower_title),xml(&c.lower_subtitle)));
    }
    if config.enabled && config.ticker_enabled {
        let period = (text_width(&config.ticker_text, 26) + 100.).max(600.) as f64;
        let shift = (time * config.ticker_speed as f64) % period;
        svg.push_str(&format!(r##"<rect x="0" y="654" width="1280" height="66" fill="#101820"/><rect x="0" y="654" width="280" height="66" fill="{}"/><g clip-path="url(#label)"><text x="20" y="696" font-family="Noto Sans, Noto Sans Bengali" font-size="20" fill="white">{}</text></g><g clip-path="url(#ticker)">"##,config.accent,xml(&config.banner_label)));
        for i in 0..3 {
            let x = 300. - shift + i as f64 * period;
            svg.push_str(&format!(r##"<text x="{x}" y="696" font-family="Noto Sans, Noto Sans Bengali" font-size="26" fill="white">{}</text>"##,xml(&config.ticker_text)));
        }
        svg.push_str("</g>");
    }
    if config.enabled && config.logo_enabled {
        if let Some(data) = &config.logo_data_url {
            let w = config.logo_width;
            let x = if config.logo_corner == "left" {
                48
            } else {
                1280 - 48 - w
            };
            svg.push_str(&format!(r##"<image x="{x}" y="36" width="{w}" height="100" preserveAspectRatio="xMidYMid meet" href="{data}"/>"##));
        }
    }
    svg.push_str("</svg>");
    let tree =
        usvg::Tree::from_str(&svg, &options()).map_err(|_| "Cannot render broadcast graphics")?;
    let mut pixels =
        tiny_skia::Pixmap::new(WIDTH, HEIGHT).ok_or("Cannot allocate graphics frame")?;
    resvg::render(
        &tree,
        tiny_skia::Transform::identity(),
        &mut pixels.as_mut(),
    );
    pixels
        .encode_png()
        .map_err(|_| "Cannot encode broadcast graphics".into())
}
async fn table(s: &AppState) -> Result<(), ApiError> {
    sqlx::query("CREATE TABLE IF NOT EXISTS graphics(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)").execute(&s.db).await?;
    Ok(())
}
async fn load(s: &AppState) -> Result<Config, ApiError> {
    table(s).await?;
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM graphics WHERE id=1")
        .fetch_optional(&s.db)
        .await?;
    let config = value
        .map(|v| serde_json::from_str::<Config>(&v))
        .transpose()
        .map_err(|_| invalid("Saved graphics settings are invalid"))?
        .unwrap_or_default();
    config.validate()?;
    Ok(config)
}
async fn get_config(State(s): State<Arc<AppState>>) -> ApiResult<Config> {
    Ok(Json(load(&s).await?))
}
async fn put_config(
    State(s): State<Arc<AppState>>,
    body: Result<Json<Config>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Config> {
    let Json(c) = body.map_err(|_| invalid("Invalid graphics settings or oversized logo"))?;
    c.validate()?;
    let _action = s.actions.lock().await;
    table(&s).await?;
    sqlx::query(
        "INSERT INTO graphics VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
    )
    .bind(serde_json::to_string(&c).map_err(|_| invalid("Cannot save graphics"))?)
    .execute(&s.db)
    .await?;
    let mut v = s.graphics.inner.lock().unwrap();
    v.previous = v.config.clone();
    v.config = Arc::new(c.clone());
    v.changed = Instant::now();
    Ok(Json(c))
}
async fn frame(State(s): State<Arc<AppState>>) -> Response {
    let v = s.graphics.inner.lock().unwrap();
    if v.frame.is_empty() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        v.frame.clone(),
    )
        .into_response()
}
async fn preview(State(s): State<Arc<AppState>>) -> ApiResult<Value> {
    let v = s.graphics.inner.lock().unwrap();
    Ok(Json(
        json!({"image":format!("data:image/png;base64,{}",STANDARD.encode(&v.frame)),"error":v.error}),
    ))
}
pub(super) fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/config",
            get(get_config)
                .put(put_config)
                .layer(DefaultBodyLimit::max(3 * 1024 * 1024)),
        )
        .route("/frame.png", get(frame))
        .route("/preview", get(preview))
}
pub(super) async fn start(s: Arc<AppState>) -> Result<(), ApiError> {
    let c = load(&s).await?;
    {
        let mut v = s.graphics.inner.lock().unwrap();
        v.config = Arc::new(c);
    }
    let initial = {
        let v = s.graphics.inner.lock().unwrap();
        v.config.clone()
    };
    let blank = tokio::task::spawn_blocking(move || render(&initial, &initial, 1., 0.))
        .await
        .map_err(|_| invalid("Cannot initialize graphics"))?
        .map_err(invalid)?;
    s.graphics.inner.lock().unwrap().frame = blank;
    tokio::spawn(async move {
        let mut last: Option<Arc<Config>> = None;
        while !s.graphics.stopped.load(Ordering::Relaxed) {
            let (c, p, age, time) = {
                let v = s.graphics.inner.lock().unwrap();
                (
                    v.config.clone(),
                    v.previous.clone(),
                    v.changed.elapsed().as_secs_f64(),
                    v.epoch.elapsed().as_secs_f64(),
                )
            };
            let changed = last.as_ref().is_none_or(|old| !Arc::ptr_eq(old, &c));
            if changed || c.visible() || (p.enabled && p.lower_third_enabled && age < 0.6) {
                let current = c.clone();
                let result =
                    tokio::task::spawn_blocking(move || render(&current, &p, age, time)).await;
                let mut v = s.graphics.inner.lock().unwrap();
                match result {
                    Ok(Ok(png)) => {
                        v.frame = png;
                        v.error = None;
                    }
                    _ => v.error = Some("Graphics rendering failed; keeping the last frame".into()),
                };
            }
            last = Some(c);
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    });
    Ok(())
}
pub(super) fn stop(s: &AppState) {
    s.graphics.stopped.store(true, Ordering::Relaxed);
}
// Add a bounded, local-only PNG input; text and uploaded images never enter FFmpeg expressions.
pub(super) fn apply(s: &AppState, args: &mut Vec<String>) {
    if s.graphics.inner.lock().unwrap().frame.is_empty() {
        return;
    }
    let maps = args
        .iter()
        .position(|a| a == "-map")
        .expect("playout maps video");
    let input_index = args[..maps].iter().filter(|a| a.as_str() == "-i").count();
    let port = s.bind_address.rsplit(':').next().unwrap_or("9780");
    let overlay: Vec<String> = [
        "-re",
        "-probesize",
        "32",
        "-analyzeduration",
        "0",
        "-threads",
        "1",
        "-thread_queue_size",
        "2",
        "-f",
        "image2",
        "-pattern_type",
        "none",
        "-loop",
        "1",
        "-framerate",
        "25",
        "-i",
        &format!("http://127.0.0.1:{port}/api/graphics/frame.png"),
    ]
    .into_iter()
    .map(String::from)
    .collect();
    args.splice(maps..maps, overlay);
    let vf = args
        .iter()
        .position(|a| a == "-vf")
        .expect("video scale filter");
    let scale = args[vf + 1].clone();
    args.drain(vf..vf + 2);
    let map = args.iter().position(|a| a == "-map").unwrap();
    args[map + 1] = "[program]".into();
    args.splice(map..map,["-filter_complex_threads".into(),"1".into(),"-filter_complex".into(),format!("[0:v]{scale}[base];[base][{input_index}:v]overlay=0:0:format=auto:shortest=1,format=yuv420p[program]")]);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_oversized_or_injected_graphics() {
        let mut c = Config {
            logo_corner: "top;movie=/etc/passwd".into(),
            ..Config::default()
        };
        assert!(c.validate().is_err());
        c = Config::default();
        c.accent = "#fff\"/>".into();
        assert!(c.validate().is_err());
        c = Config::default();
        c.logo_data_url = Some("data:image/svg+xml,<svg/>".into());
        assert!(c.validate().is_err());
        assert_eq!(xml("<script>&\"'"), "&lt;script&gt;&amp;&quot;&apos;");
    }
    #[test]
    fn renders_transparency_animation_and_bengali() {
        let mut c = Config::default();
        let empty = render(&c, &c, 1., 0.).unwrap();
        let clear = tiny_skia::Pixmap::decode_png(&empty).unwrap();
        assert!(clear.pixels().iter().all(|p| p.alpha() == 0));
        let old = c.clone();
        c.enabled = true;
        c.lower_third_enabled = true;
        c.lower_title = "সংবাদ / News".into();
        c.ticker_enabled = true;
        c.ticker_text = "Jobs & updates <live>".into();
        let a = render(&c, &old, 1., 0.).unwrap();
        let b = render(&c, &old, 1., 2.).unwrap();
        assert_ne!(a, b);
        let image = tiny_skia::Pixmap::decode_png(&a).unwrap();
        assert!(image.pixel(50, 700).unwrap().alpha() > 0);
        assert_eq!(image.pixel(1000, 100).unwrap().alpha(), 0);
        let mut logo = tiny_skia::Pixmap::new(64, 64).unwrap();
        logo.fill(tiny_skia::Color::WHITE);
        c.logo_enabled = true;
        c.logo_corner = "left".into();
        c.logo_width = 64;
        c.logo_data_url = Some(format!(
            "data:image/png;base64,{}",
            STANDARD.encode(logo.encode_png().unwrap())
        ));
        c.validate().unwrap();
        let frame = tiny_skia::Pixmap::decode_png(&render(&c, &old, 1., 3.).unwrap()).unwrap();
        assert_eq!(frame.pixel(60, 70).unwrap().alpha(), 255);
        assert_eq!(frame.pixel(60, 70).unwrap().red(), 255);
    }
}
