import { createHash } from "node:crypto";
import { BookingError } from "./rules";
import { bookingOrigin } from "./tokens";

const limits = new Map<string, { count: number; until: number }>();
/** Bounded single-process throttling; opaque tokens remain the authorization boundary. */
export function limitBookingRequest(request: Request, mutation = false) {
  const now = Date.now();
  if (limits.size > 5000) for (const [key, value] of limits) if (value.until < now) limits.delete(key);
  const route = new URL(request.url).pathname;
  const keys = ["all", createHash("sha256").update(`${mutation}:${route}`).digest("hex")];
  for (const key of keys) {
    const current = limits.get(key);
    if (!current || current.until < now) { limits.set(key, { count: 1, until: now + 60_000 }); continue; }
    if (++current.count > (key === "all" ? 1000 : mutation ? 10 : 60)) throw new BookingError("操作が続いています。少し待って再度お試しください。", 429, "RATE_LIMITED");
  }
}
export function assertBookingOrigin(request: Request) {
  if (request.headers.get("origin") !== bookingOrigin()) throw new BookingError("同じサイトから予約を操作してください。", 403, "INVALID_ORIGIN");
}
export function assertBookingLive() { if (process.env.HIGUCHI_MODE === "simulation") throw new BookingError("内蔵予約の公開ページは、本番接続と予約設定を完了した環境で利用できます。", 409, "SIMULATION_ONLY"); }
export async function readBookingBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") || 0) > 20_000) throw new BookingError("入力内容が長すぎます。", 413);
  const reader = request.body?.getReader(); if (!reader) throw new BookingError("入力内容を確認してください。");
  const decoder = new TextDecoder(); let text = "", length = 0;
  while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > 20_000) { await reader.cancel(); throw new BookingError("入力内容が長すぎます。", 413); } text += decoder.decode(part.value, { stream: true }); }
  text += decoder.decode();
  let body: unknown; try { body = JSON.parse(text); } catch { throw new BookingError("入力内容を確認してください。"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BookingError("入力内容を確認してください。");
  return body as Record<string, unknown>;
}
export function bookingJson(value: unknown, status = 200) { return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } }); }
export async function bookingError(error: unknown) {
  if (error instanceof BookingError) return bookingJson({ error: error.message, code: error.code }, error.status);
  const { authContextErrorResponse } = await import("@/lib/auth/context");
  const authError = authContextErrorResponse(error); if (authError) return authError;
  console.error("[booking] request failed", error instanceof Error ? error.message : "unknown");
  return bookingJson({ error: "予約を処理できませんでした。しばらくして再度お試しください。" }, 500);
}
