use crate::{invalid, launch_program, ApiResult, AppState};
use axum::{extract::State, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use std::sync::Arc;
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Schedule {
    start_at: String,
}
pub(super) fn router() -> Router<Arc<AppState>> {
    Router::new().route("/start", get(read).put(save).delete(cancel))
}
async fn init(s: &AppState) -> Result<(), crate::ApiError> {
    sqlx::query("CREATE TABLE IF NOT EXISTS scheduled_start(id INTEGER PRIMARY KEY CHECK(id=1),start_at TEXT NOT NULL,status TEXT NOT NULL)").execute(&s.db).await.map_err(|e|invalid(e.to_string()))?;
    Ok(())
}
async fn read(State(s): State<Arc<AppState>>) -> ApiResult<serde_json::Value> {
    init(&s).await?;
    let r = sqlx::query("SELECT start_at,status FROM scheduled_start WHERE id=1")
        .fetch_optional(&s.db)
        .await
        .map_err(|e| invalid(e.to_string()))?;
    Ok(Json(r.map(|r|json!({"startAt":r.get::<String,_>("start_at"),"status":r.get::<String,_>("status")})).unwrap_or(json!(null))))
}
async fn save(
    State(s): State<Arc<AppState>>,
    Json(body): Json<Schedule>,
) -> ApiResult<serde_json::Value> {
    let _action = s.actions.lock().await;
    let at = chrono::DateTime::parse_from_rfc3339(&body.start_at)
        .map_err(|_| invalid("Choose a valid future date and time"))?;
    if at <= chrono::Utc::now() {
        return Err(invalid("Choose a future date and time"));
    }
    init(&s).await?;
    if crate::library_rows(&s, true).await?.is_empty() {
        return Err(invalid("Add shows to the queue first"));
    }
    sqlx::query("INSERT INTO scheduled_start VALUES(1,?,'pending') ON CONFLICT(id) DO UPDATE SET start_at=excluded.start_at,status='pending'").bind(at.to_rfc3339()).execute(&s.db).await.map_err(|e|invalid(e.to_string()))?;
    Ok(Json(json!({"ok":true})))
}
async fn cancel(State(s): State<Arc<AppState>>) -> ApiResult<serde_json::Value> {
    let _action = s.actions.lock().await;
    init(&s).await?;
    sqlx::query("DELETE FROM scheduled_start")
        .execute(&s.db)
        .await
        .map_err(|e| invalid(e.to_string()))?;
    Ok(Json(json!({"ok":true})))
}
pub(super) async fn run(s: Arc<AppState>) {
    if init(&s).await.is_err() {
        return;
    }
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let _action = s.actions.lock().await;
        let Ok(Some(r)) =
            sqlx::query("SELECT start_at FROM scheduled_start WHERE id=1 AND status='pending'")
                .fetch_optional(&s.db)
                .await
        else {
            continue;
        };
        let Ok(at) = chrono::DateTime::parse_from_rfc3339(&r.get::<String, _>("start_at")) else {
            continue;
        };
        let late = chrono::Utc::now().signed_duration_since(at);
        if late.num_milliseconds() < 0 {
            continue;
        }
        let outcome = if late.num_seconds() > 60 {
            "missed"
        } else if s.runtime.lock().await.stop.is_some() {
            "skipped-active"
        } else {
            // Claim before launch: a crash must not replay a scheduled show twice.
            let claimed = sqlx::query(
                "UPDATE scheduled_start SET status='starting' WHERE id=1 AND status='pending'",
            )
            .execute(&s.db)
            .await;
            if !claimed.is_ok_and(|r| r.rows_affected() == 1) {
                continue;
            }
            if launch_program(&s, "queue").await.is_ok() {
                "started"
            } else {
                "failed"
            }
        };
        let _ = sqlx::query("UPDATE scheduled_start SET status=? WHERE id=1")
            .bind(outcome)
            .execute(&s.db)
            .await;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn schedule_rejects_empty_queue_and_past_time() {
        let s = crate::tests::web_test_state("schedule").await;
        assert!(save(
            State(s.clone()),
            Json(Schedule {
                start_at: "2000-01-01T00:00:00Z".into()
            })
        )
        .await
        .is_err());
        assert!(save(
            State(s.clone()),
            Json(Schedule {
                start_at: (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339()
            })
        )
        .await
        .is_err());
        let _ = std::fs::remove_dir_all(&s.home);
    }
    #[tokio::test]
    async fn reschedule_and_cancel_replace_the_saved_start() {
        let s = crate::tests::web_test_state("reschedule").await;
        sqlx::query("INSERT INTO media (path,title,duration,size,width,height,has_audio) VALUES('/local/show.mp4','Show',30,1024,640,360,1)").execute(&s.db).await.unwrap();
        let id: i64 = sqlx::query_scalar("SELECT id FROM media LIMIT 1")
            .fetch_one(&s.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO queue(position,media_id) VALUES(0,?)")
            .bind(id)
            .execute(&s.db)
            .await
            .unwrap();
        let first = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        let second = (chrono::Utc::now() + chrono::Duration::hours(2)).to_rfc3339();
        let _ = save(State(s.clone()), Json(Schedule { start_at: first }))
            .await
            .unwrap();
        let _ = save(
            State(s.clone()),
            Json(Schedule {
                start_at: second.clone(),
            }),
        )
        .await
        .unwrap();
        let Json(saved) = read(State(s.clone())).await.unwrap();
        assert_eq!(saved["startAt"], second);
        assert_eq!(saved["status"], "pending");
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM scheduled_start")
                .fetch_one(&s.db)
                .await
                .unwrap(),
            1
        );
        let _ = cancel(State(s.clone())).await.unwrap();
        assert!(read(State(s.clone())).await.unwrap().0.is_null());
        assert_eq!(crate::library_rows(&s, true).await.unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&s.home);
    }
}
