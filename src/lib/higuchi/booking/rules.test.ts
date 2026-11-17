import { describe, expect, test } from "bun:test";
import { assertAvailableSlot, assertCanChange, availableDays, bookingDefaults, validateBookingSettings, type BusyInterval } from "./rules";
import { bookingToken, bookingTokenHash } from "./tokens";

const now = new Date("2026-11-16T00:00:00Z"); // Monday, 09:00 JST.
const settings = () => ({ ...bookingDefaults(), enabled: true });
const start = "2026-11-17T01:00:00.000Z"; // Tuesday, 10:00 JST.
const busy: BusyInterval = { startsAt: start, endsAt: "2026-11-17T01:30:00.000Z", status: "booked" };

describe("内蔵予約の受付ルール", () => {
  test("JST平日・24時間前・15分刻み・終了後15分の余白を守る", () => {
    const days = availableDays(settings(), [], now);
    expect(days[0]?.date).toBe("2026-11-17");
    expect(days[0]?.slots[0]?.startsAt).toBe(start);
    expect(days[0]?.slots.at(-1)?.label).toBe("17:15");
    for (const day of days) {
      expect([0, 6]).not.toContain(new Date(`${day.date}T12:00:00+09:00`).getUTCDay());
      for (const slot of day.slots) {
        expect(Date.parse(slot.startsAt)).toBeGreaterThanOrEqual(now.getTime() + 86_400_000);
        expect(Date.parse(slot.startsAt)).toBeLessThanOrEqual(now.getTime() + 30 * 86_400_000);
        expect(Date.parse(slot.endsAt) - Date.parse(slot.startsAt)).toBe(30 * 60_000);
      }
    }
  });
  test("予約済み枠とその前後の余白が重なる枠を拒否し、余白終了後は受け付ける", () => {
    expect(() => assertAvailableSlot(settings(), [busy], start, now)).toThrow();
    expect(() => assertAvailableSlot(settings(), [busy], "2026-11-17T01:30:00Z", now)).toThrow();
    expect(assertAvailableSlot(settings(), [busy], "2026-11-17T01:45:00Z", now).label).toBe("10:45");
    const later: BusyInterval = { startsAt: "2026-11-17T02:00:00Z", endsAt: "2026-11-17T02:30:00Z", status: "booked" };
    expect(() => assertAvailableSlot(settings(), [later], "2026-11-17T01:30:00Z", now)).toThrow();
    expect(assertAvailableSlot(settings(), [later], start, now).label).toBe("10:00");
  });
  test("取り消した予約は枠を開放し、取り消し済み・開始済み予約は変更できない", () => {
    expect(assertAvailableSlot(settings(), [{ ...busy, status: "cancelled" }], start, now).label).toBe("10:00");
    expect(() => assertCanChange(start, "cancelled", now)).toThrow();
    expect(() => assertCanChange(start, "booked", new Date(start))).toThrow();
    expect(() => assertCanChange(start, "booked", now)).not.toThrow();
  });
  test("担当者の休業時間・公開停止・受付時間外・刻み外の指定を拒否する", () => {
    const value = settings();
    value.blocks = [{ id: "block", startsAt: "2026-11-17T01:30:00Z", endsAt: "2026-11-17T02:00:00Z", label: "別の予定" }];
    expect(() => assertAvailableSlot(value, [], start, now)).toThrow();
    expect(() => assertAvailableSlot(settings(), [], "2026-11-17T01:01:00Z", now)).toThrow();
    expect(() => assertAvailableSlot(settings(), [], "2026-11-17T08:30:00Z", now)).toThrow();
    expect(availableDays({ ...settings(), enabled: false }, [], now)).toEqual([]);
  });
  test("公開設定で担当者の変更・危険な参加URL・不正な休業時間を受け付けない", () => {
    expect(() => validateBookingSettings({ ...settings(), hostEmail: "someone@example.com" })).toThrow();
    expect(() => validateBookingSettings({ ...settings(), locationUrl: "javascript:alert(1)" })).toThrow();
    expect(() => validateBookingSettings({ ...settings(), blocks: [{ id: "x", label: "休業", startsAt: start, endsAt: start }] })).toThrow();
    expect(validateBookingSettings(settings()).timezone).toBe("Asia/Tokyo");
  });
});

describe("予約リンクのトークン", () => {
  const secret = "isolated-test-booking-secret-32-characters";
  const id = "0f4050d6-d774-4de8-b427-09be17605f85";
  test("ランダムIDから再生成できるが、用途・ID・秘密キーを越えて共有しない", () => {
    const invite = bookingToken("invite", id, secret);
    expect(invite).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bookingToken("invite", id, secret)).toBe(invite);
    expect(bookingToken("manage", id, secret)).not.toBe(invite);
    expect(bookingToken("invite", "another-random-id", secret)).not.toBe(invite);
    expect(bookingToken("invite", id, `${secret}changed`)).not.toBe(invite);
    expect(bookingTokenHash(invite)).toHaveLength(64);
    expect(bookingTokenHash(invite)).not.toBe(invite);
  });
  test("短い秘密キー・不正なトークンを拒否する", () => {
    expect(() => bookingToken("invite", id, "short")).toThrow();
    for (const token of ["", id, "../settings", "a".repeat(44), `${"a".repeat(42)}!`]) expect(() => bookingTokenHash(token)).toThrow();
  });
});
