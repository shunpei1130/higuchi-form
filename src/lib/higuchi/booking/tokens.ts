import { createHash, createHmac } from "node:crypto";
import { BookingError } from "./rules";

/** A random row UUID and a separate secret produce an opaque, reproducible 256-bit bearer token. */
export function bookingToken(kind: "invite" | "manage", randomId: string, secret: string): string {
  if (secret.length < 32) throw new BookingError("予約リンクの秘密キーが未設定です。運営者にご連絡ください。", 503, "BOOKING_UNCONFIGURED");
  return createHmac("sha256", secret).update(`higuchi-booking:v1:${kind}:${randomId}`).digest("base64url");
}
export function bookingTokenHash(token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new BookingError("予約リンクが無効か、有効期限が切れています。", 404, "INVALID_TOKEN");
  return createHash("sha256").update(token).digest("hex");
}
export function bookingSecret(): string {
  const secret = process.env.BOOKING_TOKEN_SECRET || (process.env.HIGUCHI_MODE === "simulation" ? process.env.HIGUCHI_SESSION_SECRET : "");
  if (!secret || secret.length < 32) throw new BookingError("予約リンクの秘密キーが未設定です。運営者にご連絡ください。", 503, "BOOKING_UNCONFIGURED");
  return secret;
}
export function bookingOrigin(): string {
  const input = process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!input) throw new BookingError("予約ページの公開URLが未設定です。", 503, "BOOKING_UNCONFIGURED");
  const origin = new URL(input);
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new BookingError("予約ページの公開URLはHTTPSにしてください。", 503);
  return origin.origin;
}
