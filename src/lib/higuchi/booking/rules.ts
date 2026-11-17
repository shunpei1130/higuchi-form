import { DEFAULT_BOOKING_SETTINGS, BOOKING_HOST_EMAIL, type BookingDay, type BookingSettings } from "./types";

export type BusyInterval = { id?: string; startsAt: string; endsAt: string; status: "booked" | "cancelled" };
const MINUTE = 60_000;
const DAY = 86_400_000;
const JAPAN = 9 * 60 * MINUTE;
export class BookingError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "INVALID_BOOKING") { super(message); }
}
const labelTime = (iso: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

export function validateBookingSettings(input: BookingSettings): BookingSettings {
  const settings = structuredClone(input);
  if (typeof settings.enabled !== "boolean" || settings.hostEmail !== BOOKING_HOST_EMAIL || settings.timezone !== "Asia/Tokyo") throw new BookingError("予約の担当者・タイムゾーンを確認してください。");
  for (const key of ["title", "hostName", "locationText"] as const) if (typeof settings[key] !== "string" || !settings[key].trim() || settings[key].length > 500) throw new BookingError("予約の案内情報を入力してください。");
  if (settings.durationMinutes !== 30 || settings.slotMinutes !== 15 || settings.bufferMinutes !== 15 || settings.noticeHours !== 24 || settings.horizonDays !== 30) throw new BookingError("初期の予約設定は30分・15分間隔・前日締切・30日先までです。");
  if (!Array.isArray(settings.weekdays) || !settings.weekdays.length || settings.weekdays.some((value) => !Number.isInteger(value) || value < 0 || value > 6)) throw new BookingError("予約を受け付ける曜日を選択してください。");
  settings.weekdays = [...new Set(settings.weekdays)].sort();
  for (const key of ["startTime", "endTime"] as const) if (typeof settings[key] !== "string" || !/^([01]\d|2[0-3]):(00|15|30|45)$/.test(settings[key])) throw new BookingError("受付時刻は15分刻みで設定してください。");
  if (minutes(settings.endTime) - minutes(settings.startTime) < settings.durationMinutes + settings.bufferMinutes) throw new BookingError("受付終了は開始から45分以上後に設定してください。");
  if (typeof settings.locationUrl !== "string" || settings.locationUrl.length > 2000) throw new BookingError("参加URLを確認してください。");
  if (settings.locationUrl) { let url: URL; try { url = new URL(settings.locationUrl); } catch { throw new BookingError("参加URLはhttpsで始まるURLを入力してください。"); } if (url.protocol !== "https:" || url.username || url.password) throw new BookingError("参加URLはhttpsで始まるURLを入力してください。"); }
  if (!Array.isArray(settings.blocks) || settings.blocks.length > 200) throw new BookingError("休業時間は200件以内で登録してください。");
  for (const block of settings.blocks) { if (!block || typeof block.id !== "string" || !block.id || block.id.length > 200 || typeof block.label !== "string" || block.label.length > 200 || typeof block.startsAt !== "string" || typeof block.endsAt !== "string" || !Number.isFinite(Date.parse(block.startsAt)) || !Number.isFinite(Date.parse(block.endsAt)) || Date.parse(block.endsAt) <= Date.parse(block.startsAt)) throw new BookingError("休業時間の開始・終了日時を確認してください。"); }
  return settings;
}

export function availableDays(settings: BookingSettings, booked: readonly BusyInterval[], now = new Date()): BookingDay[] {
  if (!settings.enabled) return [];
  const earliest = now.getTime() + settings.noticeHours * 3_600_000;
  const latest = now.getTime() + settings.horizonDays * DAY;
  const localDate = new Date(now.getTime() + JAPAN).toISOString().slice(0, 10);
  const midnight = Date.parse(`${localDate}T00:00:00+09:00`);
  const occupied = booked.filter((entry) => entry.status === "booked").map((entry) => ({ start: Date.parse(entry.startsAt), end: Date.parse(entry.endsAt) + settings.bufferMinutes * MINUTE }));
  const blocks = settings.blocks.map((entry) => ({ start: Date.parse(entry.startsAt), end: Date.parse(entry.endsAt) }));
  const days: BookingDay[] = [];
  for (let day = 0; day <= settings.horizonDays; day++) {
    const base = midnight + day * DAY;
    if (!settings.weekdays.includes(new Date(base + JAPAN).getUTCDay())) continue;
    const slots = [];
    for (let offset = minutes(settings.startTime); offset + settings.durationMinutes + settings.bufferMinutes <= minutes(settings.endTime); offset += settings.slotMinutes) {
      const start = base + offset * MINUTE, end = start + settings.durationMinutes * MINUTE, blockedEnd = end + settings.bufferMinutes * MINUTE;
      if (start < earliest || start > latest || occupied.some((entry) => start < entry.end && blockedEnd > entry.start) || blocks.some((entry) => start < entry.end && blockedEnd > entry.start)) continue;
      const startsAt = new Date(start).toISOString(), endsAt = new Date(end).toISOString();
      slots.push({ startsAt, endsAt, label: labelTime(startsAt) });
    }
    if (slots.length) days.push({ date: new Date(base + JAPAN).toISOString().slice(0, 10), label: new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "long", day: "numeric", weekday: "short" }).format(new Date(base)), slots });
  }
  return days;
}

export function assertAvailableSlot(settings: BookingSettings, bookings: readonly BusyInterval[], startsAt: string, now = new Date()) {
  if (!Number.isFinite(Date.parse(startsAt))) throw new BookingError("予約日時を選択してください。");
  const selected = new Date(startsAt).toISOString();
  const slot = availableDays(settings, bookings, now).flatMap((day) => day.slots).find((item) => item.startsAt === selected);
  if (!slot) throw new BookingError("この時間は予約できなくなりました。別の時間を選択してください。", 409, "SLOT_UNAVAILABLE");
  return slot;
}
export function assertCanChange(startsAt: string, status: string, now = new Date()) {
  if (status !== "booked") throw new BookingError("この予約は取り消されています。", 409, "ALREADY_CANCELLED");
  if (Date.parse(startsAt) <= now.getTime()) throw new BookingError("開始済みの予約は変更できません。担当者にご連絡ください。", 409, "MEETING_STARTED");
}
export function bookingDefaults(): BookingSettings { return structuredClone(DEFAULT_BOOKING_SETTINGS); }
