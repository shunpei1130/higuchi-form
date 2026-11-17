export type BookingBlock = { id: string; startsAt: string; endsAt: string; label: string };
export type BookingSettings = {
  enabled: boolean; title: string; hostName: string; hostEmail: string; timezone: "Asia/Tokyo";
  durationMinutes: number; slotMinutes: number; bufferMinutes: number; noticeHours: number; horizonDays: number;
  weekdays: number[]; startTime: string; endTime: string; locationUrl: string; locationText: string; blocks: BookingBlock[];
};
export type BookingSlot = { startsAt: string; endsAt: string; label: string };
export type BookingDay = { date: string; label: string; slots: BookingSlot[] };
export type PublicBookingPage = { title: string; hostName: string; timezone: "Asia/Tokyo"; durationMinutes: number; locationText: string; days: BookingDay[]; booked: boolean };
export type BookingReceipt = { id: string; title: string; hostName: string; guestName: string; guestEmail: string; startsAt: string; endsAt: string; status: "booked" | "cancelled"; timezone: "Asia/Tokyo"; locationText: string; locationUrl: string; manageUrl: string; canChange: boolean; version: number };
export const BOOKING_HOST_EMAIL = "shumpei.hasegawa@maora.co.jp";
export const DEFAULT_BOOKING_SETTINGS: BookingSettings = {
  enabled: false, title: "higuchi-form 初回相談", hostName: "MAORA株式会社 / Shumpei Hasegawa", hostEmail: BOOKING_HOST_EMAIL,
  timezone: "Asia/Tokyo", durationMinutes: 30, slotMinutes: 15, bufferMinutes: 15, noticeHours: 24, horizonDays: 30,
  weekdays: [1, 2, 3, 4, 5], startTime: "10:00", endTime: "18:00", locationUrl: "",
  locationText: "オンライン（参加URLは担当者が別途ご案内します）", blocks: [],
};
