import { config } from "../config";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: config.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Wall-clock time in the service timezone. `stamp` is comparable with slot datetimes. */
export function localNow(d: Date = new Date()) {
  const p = Object.fromEntries(formatter.formatToParts(d).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}`;
  return { date, time, stamp: `${date}T${time}` };
}

function parseDate(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

export function addDays(date: string, n: number): string {
  const dt = parseDate(date);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export function weekday(date: string): string {
  return WEEKDAYS[parseDate(date).getUTCDay()]!;
}

export function isValidDate(date: unknown): date is string {
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(parseDate(date).getTime());
}

export function isValidDateTime(dt: unknown): dt is string {
  return typeof dt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dt);
}

export function dayDiff(from: string, to: string): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86_400_000);
}

/** "2026-11-14T10:00" -> "Sat 14 Nov 2026, 10:00" */
export function slotLabel(dateTime: string): string {
  const [date, time] = dateTime.split("T");
  if (!date || !time || !isValidDate(date)) return dateTime;
  const [y, m, d] = date.split("-").map(Number);
  return `${weekday(date)} ${d} ${MONTHS[m! - 1]} ${y}, ${time}`;
}

export function clockTime(iso: string): string {
  return localNow(new Date(iso)).time;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
