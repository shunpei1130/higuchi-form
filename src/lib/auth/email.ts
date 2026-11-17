import "server-only";
import { createHash } from "node:crypto";
import { enqueueNotification } from "@/lib/higuchi/notifications";

/**
 * Transactional email for authentication — verification, password reset,
 * invitations — through Resend's REST API (POST /emails). This is platform
 * infrastructure, one sender for every organization, so it is configured in
 * env rather than in an organization's Integrations:
 *
 *   RESEND_API_KEY   — re_…
 * The sender is fixed to noreply@kodama.maora.co.jp; replies go to the
 * operator's support address. This transport never sends prospect outreach.
 *
 * The authenticated message is encrypted and persisted before this resolves.
 * A bounded durable worker performs delivery. Credentials and one-time links
 * are never written to application logs.
 */

export type AuthEmail = { to: string; subject: string; text: string; html: string };

export async function sendAuthEmail(email: AuthEmail): Promise<void> {
  if (process.env.HIGUCHI_MODE === "simulation") throw new Error("検証モードでは認証メールを送信しません。");
  if (!process.env.RESEND_API_KEY) throw new Error("認証メールが未設定です。運営者がメール配信の設定を完了してください。");
  const key=createHash("sha256").update(JSON.stringify(email)).digest("hex");
  await enqueueNotification(undefined,{to:email.to,kind:"auth",data:{subject:email.subject,text:email.text,html:email.html},idempotencyKey:`auth:${key}`});
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** One plain, client-safe layout for every auth email: a line of text and a button. */
export function authEmail(input: { to: string; subject: string; intro: string; action: string; url: string; outro?: string }): AuthEmail {
  const outro = input.outro ?? "心当たりがない場合は、このメールを無視してください。";
  const text = `${input.intro}\n\n${input.action}: ${input.url}\n\n${outro}`;
  const html = `<!doctype html><html lang="ja"><body style="margin:0;background:#f5f7fa;font-family:Inter,Arial,sans-serif;color:#0e121b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border-radius:16px;padding:32px" cellpadding="0" cellspacing="0">
<tr><td style="font-size:20px;font-weight:600;padding-bottom:16px">higuchi-form</td></tr>
<tr><td style="font-size:15px;line-height:1.6;color:#525866;padding-bottom:24px">${escapeHtml(input.intro)}</td></tr>
<tr><td style="padding-bottom:24px"><a href="${escapeHtml(input.url)}" style="display:inline-block;background:#15956f;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:10px">${escapeHtml(input.action)}</a></td></tr>
<tr><td style="font-size:13px;line-height:1.6;color:#99a0ae">${escapeHtml(outro)}<br><br>ボタンが開かない場合は、こちらのURLをブラウザーに貼り付けてください。<br><span style="word-break:break-all">${escapeHtml(input.url)}</span></td></tr>
</table></td></tr></table></body></html>`;
  return { to: input.to, subject: input.subject, text, html };
}
