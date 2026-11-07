export function moveEntry<T>(
  items: readonly T[],
  from: number,
  to: number,
): T[] {
  const result = [...items];
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  )
    return result;
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}
export function localDateTime(iso: string): string {
  const value = new Date(iso);
  if (!Number.isFinite(value.getTime())) return "";
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}T${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}
export function scheduledInstant(value: string, now = Date.now()): string {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime()) || date.getTime() <= now)
    throw new Error("Choose a future date and time.");
  if (localDateTime(date.toISOString()) !== value)
    throw new Error("That local time does not exist. Choose another time.");
  return date.toISOString();
}
