import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { CalendarClock, Clock3, Pencil, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import { duration, queueOffsets } from "@/lib/format";
import { localDateTime, scheduledInstant } from "@/lib/rundown";
import { useStudio } from "@/lib/store";
interface Schedule {
  startAt: string;
  status: string;
}
const states: Record<string, string> = {
  pending: "Scheduled",
  starting: "Starting",
  started: "Queue start requested",
  missed: "Missed — engine was unavailable",
  failed: "Failed to start — check media and engine logs",
  "skipped-active": "Skipped — another program was active",
};
export default function SchedulePanel({ onQueue }: { onQueue: () => void }) {
  const { connected, queue, status } = useStudio();
  const [schedule, setSchedule] = useState<Schedule | null>(null),
    [draft, setDraft] = useState(""),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [loaded, setLoaded] = useState(false);
  const pending = useRef(false);
  const revision = useRef(0);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const requestRevision = revision.current;
      try {
        const s = await api<Schedule | null>("/api/schedule/start");
        if (
          !cancelled &&
          !pending.current &&
          requestRevision === revision.current
        ) {
          setSchedule(s);
          setLoaded(true);
        }
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connected]);
  const active = status?.state === "live" || status?.state === "starting";
  const start =
    editing || !schedule
      ? new Date(draft).getTime()
      : new Date(schedule.startAt).getTime();
  const offsets = queueOffsets(queue),
    total = queue.reduce((n, v) => n + v.durationSeconds, 0);
  async function save(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending.current) return;
    pending.current = true;
    revision.current++;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const startAt = scheduledInstant(draft);
      await api("/api/schedule/start", "PUT", { startAt });
      setSchedule(await api<Schedule>("/api/schedule/start"));
      setEditing(false);
      setDraft("");
      setNotice("Scheduled start saved on this computer.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function cancel() {
    if (pending.current) return;
    pending.current = true;
    revision.current++;
    setBusy(true);
    setError("");
    try {
      await api("/api/schedule/start", "DELETE");
      setSchedule(null);
      setDraft("");
      setEditing(false);
      setNotice("Scheduled start cancelled. Current playout is unchanged.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="schedule-workspace">
      <article className="panel schedule-editor">
        <div className="panel-heading">
          <div className="section-title">
            <h2>
              <CalendarClock size={19} /> Schedule your lineup
            </h2>
            <span>
              One-time queue start ·{" "}
              {Intl.DateTimeFormat().resolvedOptions().timeZone}
            </span>
          </div>
          <span className="pill">
            {schedule
              ? (states[schedule.status] ?? schedule.status)
              : "No scheduled start"}
          </span>
        </div>
        <div className="schedule-body">
          {schedule && !editing ? (
            <>
              <p className="schedule-date">
                {new Date(schedule.startAt).toLocaleString(undefined, {
                  dateStyle: "full",
                  timeStyle: "short",
                })}
              </p>
              <p>
                {schedule.status === "pending"
                  ? "The saved running order will start at this time. Queue edits update this lineup."
                  : "This start is no longer pending. Choose a new time to schedule the queue again."}
              </p>
              <div className="relay-buttons">
                <Button
                  disabled={busy || !connected || !loaded}
                  onClick={() => {
                    setDraft(localDateTime(schedule.startAt));
                    setEditing(true);
                    setError("");
                    setNotice("");
                  }}
                >
                  <Pencil size={15} />
                  {schedule.status === "pending"
                    ? "Reschedule"
                    : "Schedule again"}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !connected}
                  onClick={() => void cancel()}
                >
                  <X size={15} />
                  {schedule.status === "pending"
                    ? "Cancel scheduled start"
                    : "Clear history"}
                </Button>
              </div>
            </>
          ) : (
            <form onSubmit={(e) => void save(e)} className="schedule-form">
              <label htmlFor="scheduled-start">Start date and local time</label>
              <Input
                id="scheduled-start"
                type="datetime-local"
                required
                disabled={busy || !connected}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onInput={(e) => setDraft(e.currentTarget.value)}
              />
              <div className="relay-buttons">
                <Button
                  type="submit"
                  disabled={
                    !connected || busy || !loaded || !queue.length || !draft
                  }
                >
                  <Save size={15} />
                  {busy
                    ? "Saving…"
                    : editing
                      ? "Save new time"
                      : "Schedule queue"}
                </Button>
                {editing && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setEditing(false);
                      setDraft("");
                      setError("");
                    }}
                  >
                    Discard changes
                  </Button>
                )}
              </div>
            </form>
          )}
          {!queue.length && (
            <p className="form-error">
              Add programs to the playout queue before scheduling.
            </p>
          )}
          {active && (
            <p className="schedule-warning">
              A program is running. Stop it before the scheduled time; the
              scheduler never interrupts an active broadcast.
            </p>
          )}
          <p>
            Keep this computer awake and the engine running. Enable LAN relay
            output in advance. Test a new queue once to prepare its local video
            cache before scheduling.
          </p>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
        </div>
      </article>
      <article className="panel">
        <div className="panel-heading">
          <div className="section-title">
            <h2>
              <Clock3 size={18} /> Scheduled rundown
            </h2>
            <span>
              {queue.length} programs · {duration(total)} per run
            </span>
          </div>
          <Button variant="outline" onClick={onQueue}>
            Edit running order
          </Button>
        </div>
        <div className="schedule-preview">
          {queue.length ? (
            queue.map((item, i) => (
              <div className="schedule-program" key={`${item.id}-${i}`}>
                <span className="mono">
                  {Number.isFinite(start)
                    ? new Date(start + offsets[i] * 1000).toLocaleString(
                        undefined,
                        {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        },
                      )
                    : `+${duration(offsets[i])}`}
                </span>
                <strong>{item.title}</strong>
                <span className="mono">{duration(item.durationSeconds)}</span>
              </div>
            ))
          ) : (
            <p>Your lineup will appear here after you add programs.</p>
          )}
        </div>
      </article>
    </section>
  );
}
