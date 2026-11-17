"use client";

import Link from "next/link";
import { ArrowRight, Check, LoaderCircle, X } from "lucide-react";
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { formatMoney, type MoneyCurrency } from "@/lib/higuchi/money";

export const usd = (amountMinor: number, currency:MoneyCurrency="USD") => formatMoney(amountMinor,currency);
export const money = formatMoney;
export const count = (value: number) => new Intl.NumberFormat("ja-JP").format(value);
export const dateTime = (value: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));

export function Brand({ compact = false }: { compact?: boolean }) {
  return <Link href="/" className="hf-brand" aria-label="higuchi-form トップページ"><img src="/higuchi-mark.svg" width={18} height={28} alt="" />{!compact && <span>higuchi-form</span>}</Link>;
}

export function Button({ variant = "primary", busy = false, children, className = "", disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; busy?: boolean }) {
  return <button {...props} disabled={disabled || busy} className={`hf-button hf-button-${variant} ${className}`} aria-busy={busy || undefined}>{busy && <LoaderCircle size={16} className="hf-spin" aria-hidden="true" />}{children}</button>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <div className="hf-page-header"><div>{eyebrow && <p className="hf-eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="hf-description">{description}</p>}</div>{actions && <div className="hf-header-actions">{actions}</div>}</div>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`hf-card ${className}`}>{children}</section>;
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="hf-empty">{icon && <div className="hf-empty-icon">{icon}</div>}<h2>{title}</h2><p>{description}</p>{action}</div>;
}

const statuses: Record<string, [string, string]> = {
  running: ["稼働中", "green"], needs_setup: ["設定が必要", "amber"], idle: ["未利用", "neutral"], topup: ["前払い", "green"], email: ["営業メール", "blue"], completed: ["完了", "green"],
  draft: ["下書き", "neutral"], discovery: ["顧客像を整理中", "blue"], searching: ["顧客を探索中", "blue"], review: ["確認待ち", "amber"], outreach: ["稼働中", "green"], active: ["稼働中", "green"], paused: ["停止中", "neutral"], archived: ["アーカイブ", "neutral"], waiting_for_data: ["顧客データ待ち", "amber"], data_pending: ["顧客データ待ち", "amber"], source_pending: ["顧客データ待ち", "amber"], new: ["未送信", "neutral"], queued: ["送信待ち", "amber"], sent: ["送信済み", "blue"], contacted: ["送信済み", "blue"], replied: ["返信あり", "green"], interested: ["ホットリード", "green"], hot: ["ホットリード", "green"], booked: ["商談予約済み", "green"], suppressed: ["配信停止", "neutral"], unsubscribed: ["配信停止", "neutral"], not_interested: ["見送り", "neutral"], unconfigured: ["未接続", "neutral"], connected: ["接続済み", "green"], simulation: ["シミュレーション", "amber"], verified: ["確認済み", "green"], past_due: ["お支払いを確認", "red"], failed: ["失敗", "red"], pending: ["確認待ち", "amber"], ready: ["準備完了", "green"], scheduled: ["予定済み", "blue"], delivery_uncertain: ["送信結果の照合待ち", "amber"], needs_reply: ["要返信", "amber"], needs_review: ["確認待ち", "amber"], action_required: ["要対応", "amber"], positive: ["前向きな返信", "green"], negative: ["見送り", "neutral"], resolved: ["対応済み", "green"], open: ["対応中", "blue"], unassigned: ["未割り当て", "neutral"], assigned: ["割り当て済み", "green"], healthy: ["正常", "green"], warming: ["準備中", "amber"], disabled: ["無効", "neutral"], live: ["本番", "green"], imported: ["取り込み済み", "neutral"], analyzing: ["解析中", "blue"], cancelled: ["取消", "neutral"], bounced: ["不達", "red"], trial: ["無料枠", "green"], prepay: ["前払い", "green"], usage: ["利用", "blue"], refund: ["返金", "neutral"], free_grant: ["無料枠", "green"], paid: ["支払い済み", "green"], not_configured: ["未設定", "neutral"], pending_payment: ["お支払い待ち", "amber"], not_connected: ["未接続", "neutral"], sample: ["サンプル", "amber"]
};
export function Status({ value, label }: { value: string; label?: string }) {
  const [text, color] = statuses[value] ?? ["確認が必要", "neutral"];
  return <span className={`hf-status hf-status-${color}`}><span aria-hidden="true" />{label ?? text}</span>;
}

export function Toggle({ checked, onChange, label, description, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  const id = useId();
  return <div className="hf-toggle-row"><div><label id={id}>{label}</label>{description && <p>{description}</p>}</div><button type="button" className={`hf-toggle ${checked ? "is-on" : ""}`} role="switch" aria-checked={checked} aria-labelledby={id} disabled={disabled} onClick={() => onChange(!checked)}><span /></button></div>;
}

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { const element = ref.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={ref} className={`hf-dialog ${wide ? "hf-dialog-wide" : ""}`} aria-labelledby={titleId} onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="hf-dialog-header"><h2 id={titleId}>{title}</h2><button type="button" className="hf-icon-button" aria-label="閉じる" onClick={onClose}><X size={20} /></button></div>{children}</dialog>;
}

export function InlineNote({ children, kind = "info" }: { children: ReactNode; kind?: "info" | "success" | "warning" }) {
  return <div className={`hf-note hf-note-${kind}`}>{kind === "success" && <Check size={17} aria-hidden="true" />}<div>{children}</div></div>;
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) { return <Link className="hf-text-link" href={href}>{children}<ArrowRight size={15} aria-hidden="true" /></Link>; }
