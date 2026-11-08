import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { useStudio } from "@/lib/store";
import { errorMessage } from "@/lib/api";

export default function AppUpdates() {
  const [update, setUpdate] = useState<{ version: string } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const status = useStudio((s) => s.status);
  const active = status?.state === "live" || status?.state === "starting";
  async function check(manual = false) {
    try {
      const available = await invoke<{ version: string } | null>(
        "check_update",
      );
      setUpdate(available);
      setMessage(
        available
          ? `Version ${available.version} is available`
          : manual
            ? "You’re up to date"
            : "",
      );
    } catch (e) {
      if (manual) setMessage(errorMessage(e));
    }
  }
  useEffect(() => {
    if (!isTauri()) return;
    void check();
    const timer = setInterval(() => void check(), 6 * 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);
  if (!isTauri()) return null;
  return (
    <div className="update-controls">
      <Button variant="ghost" disabled={busy} onClick={() => void check(true)}>
        Check for updates
      </Button>
      <span role="status">{message}</span>
      {update && (
        <Button
          disabled={busy || active || !status}
          onClick={async () => {
            setBusy(true);
            setMessage("Downloading and verifying update…");
            try {
              await invoke("install_update");
            } catch (e) {
              setMessage(errorMessage(e));
              setBusy(false);
            }
          }}
        >
          {busy ? "Updating…" : "Install update"}
        </Button>
      )}
      {update && active && (
        <small>Stop broadcasting to install the update.</small>
      )}
    </div>
  );
}
