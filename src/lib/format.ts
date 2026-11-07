export function duration(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainder = String(safe % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`
    : `${minutes}:${remainder}`;
}

export function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

export function viewerCapacity(
  uploadMbps: number,
  bitrateKbps: number,
): number {
  if (uploadMbps <= 0 || bitrateKbps <= 0) return 0;
  return Math.floor((uploadMbps * 1000 * 0.7) / ((bitrateKbps + 128) * 1.1));
}

export function queueOffsets(items: { durationSeconds: number }[]): number[] {
  let offset = 0;
  return items.map((item) => {
    const start = offset;
    offset += item.durationSeconds;
    return start;
  });
}
