import { useEffect, useState, useRef } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Loader2 } from "lucide-react";
import { api, errorMessage, uploadMedia } from "@/lib/api";
import { useStudio } from "@/lib/store";
import { Button } from "@/components/ui/button";

export default function MediaDropZone() {
  const [message, setMessage] = useState(
    "Drop multiple videos here to import them",
  );
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  async function importFiles(files: (string | File)[]) {
    if (pending.current || !files.length) return;
    pending.current = true;
    setBusy(true);
    const failures: string[] = [];
    let count = 0;
    try {
      for (const file of files) {
        setMessage(
          `Importing ${count + failures.length + 1} of ${files.length}…`,
        );
        try {
          if (typeof file === "string") {
            await api("/api/library", "POST", { path: file });
          } else {
            const localPath = (file as unknown as { path?: unknown }).path;
            if (typeof localPath === "string") {
              await api("/api/library", "POST", { path: localPath });
            } else if (isTauri()) {
              throw new Error(
                `Cannot resolve local file path for "${file.name}". Please click "Choose videos" to select files.`,
              );
            } else {
              await uploadMedia(file);
            }
          }
          count++;
        } catch (error) {
          const fileName = typeof file === "string" ? file : file.name;
          failures.push(`${fileName}: ${errorMessage(error)}`);
        }
      }
      try {
        await useStudio.getState().refresh();
      } catch (refreshErr) {
        console.error("Failed to refresh library after import:", refreshErr);
      }
      if (failures.length > 0 && count === 0) {
        setMessage(`Import failed: ${failures.join(" · ")}`);
      } else {
        setMessage(
          `Imported ${count} of ${files.length} videos.${failures.length ? " " + failures.join(" · ") : ""}`,
        );
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === "drop" && payload.paths?.length) {
          void importFiles(payload.paths);
        }
      })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <div
      className="media-drop-zone"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const dropped = Array.from(e.dataTransfer.files);
        if (dropped.length > 0) {
          void importFiles(dropped);
        }
      }}
    >
      <p role="status">{message}</p>
      {isTauri() ? (
        <Button
          disabled={busy}
          variant="outline"
          onClick={async () => {
            try {
              const selected = await invoke<string[]>("pick_media_files");
              if (selected && selected.length > 0) {
                await importFiles(selected);
              }
            } catch (e) {
              setMessage(errorMessage(e));
            }
          }}
        >
          {busy ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              <span>Importing…</span>
            </>
          ) : (
            "Choose videos"
          )}
        </Button>
      ) : (
        <label>
          Choose videos{" "}
          <input
            type="file"
            multiple
            accept="video/*,.mkv,.ts,.m4v"
            disabled={busy}
            onChange={(e) => {
              void importFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </label>
      )}
    </div>
  );
}
