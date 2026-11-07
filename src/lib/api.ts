import { invoke, isTauri } from "@tauri-apps/api/core";

export interface MediaItem {
  id: number;
  title: string;
  path: string;
  durationSeconds: number;
  sizeBytes: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface Settings {
  channelName: string;
  bitrateKbps: number;
  publicHost: string;
  hlsPort: number;
  rtspPort: number;
  loopQueue: boolean;
}

export interface BroadcastStatus {
  state: "idle" | "starting" | "live" | "error";
  source: "test" | "queue" | "camera" | null;
  currentTitle: string | null;
  startedAt: string | null;
  bitrateKbps: number;
  fps: number;
  viewers: number | null;
  hlsUrl: string;
  publicUrl: string;
  error: string | null;
  logs: string[];
}

export interface Diagnostics {
  ffmpeg: { available: boolean; version: string | null };
  ffprobe: { available: boolean; version: string | null };
  mediamtx: { available: boolean; version: string | null };
  dataDir: string;
  controlAddress: string;
  platform: string;
  setupScript?: string;
  webMode?: boolean;
}

export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (isTauri())
    return invoke<T>("api_request", { method, path, body: body ?? null });
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return readResponse<T>(response);
}

async function readResponse<T>(response: Response): Promise<T> {
  const result = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      result?.error ??
        "The broadcast service is unavailable. Start the local service and reconnect.",
    );
  return result as T;
}

export async function uploadMedia(file: File): Promise<MediaItem> {
  if (file.size === 0 || file.size > 2 * 1024 ** 3)
    throw new Error("Choose a nonempty video up to 2 GiB.");
  const body = new FormData();
  body.append("file", file);
  return readResponse<MediaItem>(
    await fetch("/api/library/upload", { method: "POST", body }),
  );
}

export async function pickMedia(): Promise<string | null> {
  return isTauri() ? invoke<string | null>("pick_media") : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
