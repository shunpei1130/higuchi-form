import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const GOOGLE_MAIL_SENDER = "shumpei.hasegawa@maora.co.jp";
export const GOOGLE_MAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"] as const;
export const GOOGLE_MAIL_CALLBACK = "https://form-higuchi.vercel.app/api/higuchi/mail/callback";
export type MailOAuthState = { organizationId: string; userId: string; nonce: string; expiresAt: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function signMailState(value: MailOAuthState, secret: string): string {
  if (!secret) throw new Error("メール接続の認証設定がありません。");
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(`higuchi-mail-oauth:${body}`).digest("base64url")}`;
}
export function verifyMailState(value: string, userId: string, secret: string, now = Date.now()): MailOAuthState {
  if (!secret || value.length > 4096) throw new Error("メール接続の状態が無効です。");
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra) throw new Error("メール接続の状態が無効です。");
  const expected = createHmac("sha256", secret).update(`higuchi-mail-oauth:${body}`).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("メール接続の状態が無効です。");
  const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("メール接続の状態が無効です。");
  const state = parsed as MailOAuthState;
  if (!uuid.test(state.organizationId) || state.userId !== userId || typeof state.nonce !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(state.nonce) || !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= now || state.expiresAt > now + 11 * 60_000) throw new Error("メール接続の有効期限が切れているか、ログイン情報が一致しません。");
  return state;
}
export function googleMailMessageId(organizationId: string, messageId: string): string {
  if (!organizationId || !messageId || messageId.length > 300) throw new Error("送信IDが正しくありません。");
  return `<higuchi.${createHash("sha256").update(`${organizationId}:${messageId}`).digest("hex")}@maora.co.jp>`;
}
export function singleEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(email)) throw new Error("メールアドレスが正しくありません。");
  return email;
}
function safeHeader(value: string): string {
  if (/[\r\n\u0000]/.test(value)) throw new Error("メールのヘッダーが正しくありません。");
  return value;
}
export function buildGoogleMail(input: {organizationId:string;messageId:string;to:string;subject:string;body:string;inReplyTo?:string;references?:string[];unsubscribeUrl?:string}): {raw:string;rfcMessageId:string} {
  const to = singleEmail(input.to);
  if (!input.subject.trim() || input.subject.length > 500 || !input.body.trim() || input.body.length > 100_000) throw new Error("メールの件名または本文が正しくありません。");
  safeHeader(input.subject);
  const rfcMessageId = googleMailMessageId(input.organizationId, input.messageId);
  const headers = [`From: higuchi-form <${GOOGLE_MAIL_SENDER}>`, `To: ${to}`, `Subject: =?UTF-8?B?${Buffer.from(input.subject).toString("base64")}?=`, `Message-ID: ${rfcMessageId}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "Auto-Submitted: auto-generated"];
  if (input.inReplyTo) headers.push(`In-Reply-To: ${safeHeader(input.inReplyTo)}`);
  if (input.references?.length) headers.push(`References: ${input.references.slice(-20).map(safeHeader).join(" ")}`);
  if (input.unsubscribeUrl) {
    const url = new URL(input.unsubscribeUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("配信停止URLが正しくありません。");
    headers.push(`List-Unsubscribe: <${safeHeader(url.href)}>`);
  }
  const body = Buffer.from(input.body.replace(/\r?\n/g, "\r\n")).toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  return {raw: Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}\r\n`).toString("base64url"), rfcMessageId};
}
type GmailPart = {mimeType?:string;filename?:string;body?:{data?:string;size?:number};parts?:GmailPart[]};
export function gmailPlainText(part: GmailPart, depth = 0): string {
  if (depth > 8 || part.filename) return "";
  if (part.mimeType === "text/plain" && part.body?.data && (part.body.size ?? 0) <= 100_000) return Buffer.from(part.body.data.slice(0,140_000), "base64url").toString("utf8").slice(0,64_000);
  const children=(part.parts ?? []).slice(0,20);
  const plain=children.filter(child=>child.mimeType!=="text/html").map(child=>gmailPlainText(child,depth+1)).filter(Boolean).join("\n");
  if(plain)return plain.slice(0,64_000);
  if(part.mimeType==="text/html"&&part.body?.data&&(part.body.size??0)<=100_000){
    return Buffer.from(part.body.data.slice(0,140_000),"base64url").toString("utf8").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,"").replace(/<(?:br|\/p|\/div|\/li)\b[^>]*>/gi,"\n").replace(/<[^>]+>/g,"").replace(/&nbsp;/gi," ").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&quot;/gi,'"').replace(/&#39;/g,"'").replace(/&amp;/gi,"&").slice(0,64_000);
  }
  return children.filter(child=>child.mimeType==="text/html").map(child=>gmailPlainText(child,depth+1)).filter(Boolean).join("\n").slice(0,64_000);
}
export function emailFromHeader(value: string): string | null {
  const raw = value.match(/<([^<>]+)>/)?.[1] ?? value;
  try { return singleEmail(raw); } catch { return null; }
}
