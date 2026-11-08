import { useEffect, useState, useRef } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
    for (const file of files) {
      setMessage(
        `Importing ${count + failures.length + 1} of ${files.length}…`,
      );
      try {
        if (typeof file === "string")
          await api("/api/library", "POST", { path: file });
        else await uploadMedia(file);
        count++;
      } catch (error) {
        failures.push(
          `${typeof file === "string" ? file : file.name}: ${errorMessage(error)}`,
        );
      }
    }
    await useStudio.getState().refresh();
    setMessage(
      `Imported ${count} of ${files.length} videos.${failures.length ? " " + failures.join(" · ") : ""}`,
    );
    pending.current = false;
    setBusy(false);
  }
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === "drop") void importFiles(payload.paths);
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
        if (!isTauri()) void importFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <p role="status">{message}</p>
      {isTauri() ? (
        <Button
          disabled={busy}
          variant="outline"
          onClick={async () => {
            try {
              await importFiles(await invoke<string[]>("pick_media_files"));
            } catch (e) {
              setMessage(errorMessage(e));
            }
          }}
        >
          Choose videos
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
