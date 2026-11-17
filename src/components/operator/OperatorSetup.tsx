"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { IntegrationStates } from "@/lib/higuchi/types";
import { GoogleMailConnection } from "./GoogleMailConnection";
import { StripeBillingSetup } from "./StripeBillingSetup";
import "./operator.css";

type Organization = { id: string; name: string };
type Mailbox = { id: string; emailAddress: string; displayName: string | null; status: string; dailySendLimit: number };
type AdminStatus = { mailboxes: Mailbox[]; integrations?: IntegrationStates; aiBudget?: { month: string; usedMicros: number; limitMicros: number } };
const STATUS_LABELS = { ai: "会社分析・文面作成", email: "メール送信", booking: "内蔵の商談予約", billing: "決済・従量課金" } as const;
const usd = (micros: number) => new Intl.NumberFormat("ja-JP", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(micros / 1_000_000);

export function OperatorSetup({ simulation, organizationId = "", organizationName = "運営ワークスペース", forbidden = false }: { simulation: boolean; organizationId?: string; organizationName?: string; forbidden?: boolean }) {
  const formId = useId();
  const [organizations, setOrganizations] = useState<Organization[]>(organizationId ? [{ id: organizationId, name: organizationName }] : []);
  const [targetId, setTargetId] = useState(organizationId);
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(""), [expired, setExpired] = useState(false);
  const refreshSequence = useRef(0);
  const disabled = simulation || forbidden || expired;
  const api = useCallback(async (path: string) => {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) { setExpired(true); throw new Error("ログインの有効期限が切れました。再度ログインしてください。"); }
      if (response.status === 403) throw new Error("この操作は運営ワークスペースの管理者のみが実行できます。");
      throw new Error(typeof value.error === "string" ? value.error : "設定を取得できませんでした。しばらくして再度お試しください。");
    }
    return value;
  }, []);
  const refresh = useCallback(async (id: string) => {
    if (simulation || forbidden || !id) return;
    const sequence = ++refreshSequence.current; setLoading(true); setError("");
    try {
      const value = await api(`/api/higuchi/admin?organizationId=${encodeURIComponent(id)}`);
      if (sequence === refreshSequence.current) setStatus({ mailboxes: value.mailboxes ?? [], integrations: value.integrations, aiBudget: value.aiBudget });
    } catch (cause) {
      if (sequence === refreshSequence.current) { setError(cause instanceof Error ? cause.message : "接続状態を取得できませんでした。"); setStatus(null); }
    } finally { if (sequence === refreshSequence.current) setLoading(false); }
  }, [api, simulation, forbidden]);
  useEffect(() => { if (simulation || forbidden) return; let active = true;
    void api("/api/higuchi/admin").then(value => { if (active && Array.isArray(value.organizations)) setOrganizations(value.organizations); }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "組織一覧を取得できませんでした。"); });
    return () => { active = false; };
  }, [api, simulation, forbidden]);
  useEffect(() => { setStatus(null); void refresh(targetId); return () => { refreshSequence.current++; }; }, [targetId, refresh]);
  const selectedName = organizations.find(item => item.id === targetId)?.name ?? "選択した組織";
  return <main className="operator-setup">
    <header className="op-header"><Link href="/app/settings" className="op-back">← 設定に戻る</Link><span className="op-brand">higuchi-form</span></header>
    <section className="op-intro"><p className="op-eyebrow">運営者向け</p><h1>サービスの接続設定</h1><p>AI、営業メール、商談予約、決済の状態を確認します。営業メールを開始する前に、送信元と予算を確認してください。</p></section>
    {simulation && <div className="op-banner" role="status"><strong>シミュレーション環境です</strong><p>設定項目のプレビューです。この環境では外部サービスへの接続・送信・決済を行いません。</p></div>}
    {forbidden && <div className="op-error" role="alert"><strong>運営者の権限が必要です</strong><p>初期の運営ワークスペースに所属するオーナー、または管理者でログインしてください。</p></div>}
    {error && <div className="op-error" role="alert">{error}{expired && <p><Link href="/sign-in?from=%2Foperator">ログイン画面を開く</Link></p>}</div>}
    <section className="op-card"><div className="op-section-heading"><div><h2>設定する組織</h2><p>「{selectedName}」の接続状態を確認します。</p></div><button type="button" className="op-secondary" disabled={disabled || loading || !targetId} onClick={() => void refresh(targetId)}>{loading ? "確認中…" : "接続状態を確認"}</button></div>
      <label htmlFor={`${formId}-organization`}>組織</label><select id={`${formId}-organization`} value={targetId} disabled={disabled} onChange={event => setTargetId(event.target.value)}><option value="">組織を選択してください</option>{organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <div className="op-status-grid">{Object.entries(STATUS_LABELS).map(([key, label]) => { const connection = status?.integrations?.[key as keyof IntegrationStates]; return <div className="op-status" key={key}><span>{label}</span><strong className={connection?.connected ? "op-ready" : ""}>{simulation ? "検証用" : loading ? "確認中" : connection?.connected ? "設定済み" : "要設定"}</strong></div>; })}</div>
    </section>
    <section className="op-card"><h2>1. AIの接続と利用上限</h2><p>OpenAI APIの <strong>gpt-6-luna</strong> で事業分析とメール文面の作成を行います。APIキーはサービスの公開先で管理します。</p><div className="op-status-grid"><div className="op-status"><span>月間上限（全組織の合計）</span><strong>{status?.aiBudget ? usd(status.aiBudget.limitMicros) : "US$20"}</strong></div><div className="op-status"><span>今月の利用額・処理中の予約額</span><strong>{simulation ? "検証用" : status?.aiBudget ? usd(status.aiBudget.usedMicros) : "未取得"}</strong></div></div><p className="op-help">{status?.aiBudget?.month && `${status.aiBudget.month}（UTC）の集計です。`}処理中・結果不明の呼び出しも予算に含め、上限を超える新しい呼び出しを止めます。営業メールの利用料金とは別の運営側の上限です。</p></section>
    <div className="op-card">{!disabled && targetId ? <GoogleMailConnection key={targetId} organizationId={targetId} /> : <><h2>2. Googleメール</h2><p>営業メールは shumpei.hasegawa@maora.co.jp から送信します。本番環境で組織を選び、Googleアカウントを接続してください。</p></>}
      <div className="op-mailboxes"><h3>割り当て済みの送信元</h3>{status?.mailboxes.length ? <ul>{status.mailboxes.map(box => <li key={box.id}><div><strong>{box.displayName || box.emailAddress}</strong>{box.displayName && <span>{box.emailAddress}</span>}</div><span>{box.status === "connected" ? "接続済み" : box.status === "disabled" ? "停止中" : "接続を確認してください"} · 1日{box.dailySendLimit}件</span></li>)}</ul> : <p className="op-small">{simulation ? "シミュレーションでは送信元を割り当てません。" : "まだ割り当てられた送信元はありません。"}</p>}</div>
    </div>
    <StripeBillingSetup key={targetId} organizationId={targetId} disabled={disabled} simulation={simulation} onSaved={() => void refresh(targetId)} />
    <section className="op-card"><h2>4. 商談予約と通知メール</h2><p>内蔵予約ページで、予約・日程変更・取消を受け付けます。外部カレンダーとの同期や参加URLの自動作成は行いません。</p><div className="op-links"><Link href="/app/settings">ワークスペースの予約設定を開く</Link><Link href="/app/meetings">商談予約の一覧を開く</Link></div><p className="op-help">予約設定は、ログイン中のワークスペースに適用されます。別の組織を設定する場合は、そのワークスペースへ切り替えてください。</p><p>ログイン・予約の通知メールは、higuchi-form &lt;noreply@kodama.maora.co.jp&gt; から配信します。返信先は s.hasegawa1130@gmail.com です。</p><p className="op-help">予約と通知の登録は一緒に保存します。送信に失敗した通知は、保存された配信処理から再試行します。</p></section>
    <footer className="op-footer"><Link href="/app/settings">設定に戻る</Link><span>MAORA株式会社 / higuchi-form</span></footer>
  </main>;
}