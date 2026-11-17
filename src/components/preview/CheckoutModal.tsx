"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, Check, CreditCard, Gift, LoaderCircle, LockKeyhole, Mail, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { authClient, useSession } from "@/lib/auth/client";
import type { PreviewSnapshot } from "@/lib/higuchi/preview/types";
import type { BillingState } from "@/lib/higuchi/types";
import { claimPreview, consentPreview, getPreview, startPreview, type PreviewClaim } from "./api";

const TOPUPS = [4500, 7500, 15000] as const;
const yen = (value: number) => `${value.toLocaleString("ja-JP")}円`;
const EmbeddedCheckout = dynamic(() => import("@/components/higuchi/EmbeddedCheckout").then(module => module.EmbeddedCheckout), { ssr: false, loading: () => <p className="pv-field-hint" role="status">決済フォームを読み込んでいます。</p> });

export function CheckoutModal({ open, onOpenChange, preview }: { open: boolean; onOpenChange: (open: boolean) => void; preview: PreviewSnapshot }) {
  const { data: session } = useSession();
  const [plan, setPlan] = useState<"prepaid" | "usage">("prepaid");
  const [amount, setAmount] = useState<number>(4500);
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [financialBusy, setFinancialBusy] = useState(false);
  const [error, setError] = useState("");
  const [terms, setTerms] = useState(false);
  const [startConsent, setStartConsent] = useState(false);
  const [claim, setClaim] = useState<PreviewClaim | null>(null);
  const [complete, setComplete] = useState(false);
  const [paymentState, setPaymentState] = useState<"idle" | "waiting" | "pending" | "started">("idle");
  const [startedUrl, setStartedUrl] = useState("");
  const [returning, setReturning] = useState(false);
  const [bonusEligible, setBonusEligible] = useState<boolean | null>(null);
  const requestId = useRef<string>("");
  const startRequestId = useRef<string>("");
  const checkingPayment = useRef(false);
  const verified = Boolean(session?.user.emailVerified);
  const billingAllowed = !preview.sample && (preview.capabilities.canCheckout || preview.status === "claimed" && Boolean(preview.claimedProjectId));
  const planLocked = busy || financialBusy || complete;
  const multiplier = bonusEligible === false ? 1 : 2;
  useEffect(() => { setReturning(new URLSearchParams(window.location.search).get("billing_return") === "1"); }, []);
  useEffect(() => { if (!complete) setStartConsent(false); }, [preview.revision, open, complete]);

  async function claimResult() {
    if (!billingAllowed) return;
    if (!requestId.current) requestId.current = crypto.randomUUID();
    const latest = await getPreview(preview.id);
    const claimed = await claimPreview(preview.id, latest.revision, requestId.current);
    const billing = await readBilling();
    setClaim(claimed);
    setBonusEligible(!billing.trialClaimed && !billing.firstTopupCompleted);
    if (returning || billing.verifiedPreviewSessions?.[preview.id]) showPaymentResume(billing);
  }

  function showPaymentResume(billing: BillingState) {
    const pending = billing.pendingPreviewSessions?.[preview.id];
    if (pending) { setPlan(pending.mode === "payment" ? "prepaid" : "usage"); if (pending.mode === "payment") setAmount(pending.amountMinor); }
    else setError("この準備に紐づく決済が見つかりません。追加の支払いは行わず、管理画面でご確認ください。");
    setReturning(true); setTerms(false); setStartConsent(false); setFinancialBusy(false); setComplete(true); setPaymentState("pending");
  }

  async function resumeConfirmedPayment() {
    setReturning(true); setComplete(true); setPaymentState("pending"); setTerms(false); setStartConsent(false); setFinancialBusy(false);
    try { showPaymentResume(await readBilling()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "決済結果を確認できませんでした。追加で支払わず、管理画面でご確認ください。"); }
  }

  async function readBilling(): Promise<BillingState> {
    const response = await fetch("/api/higuchi/workspace", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error("決済の反映状況を確認できませんでした。もう一度、反映を確認してください。");
    const snapshot = await response.json() as { billing: BillingState };
    return snapshot.billing;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !billingAllowed) return;
    setBusy(true); setError("");
    try {
      if (verified) { await claimResult(); return; }
      if (!sent) {
        const result = await authClient.emailOtp.sendVerificationOtp({ email: email.trim(), type: "sign-in" });
        if (result.error) throw new Error("認証コードを送れませんでした。メールアドレスをご確認ください。");
        setSent(true);
      } else {
        const result = await authClient.signIn.emailOtp({ email: email.trim(), otp });
        if (result.error) throw new Error("コードが正しくないか、有効期限が切れています。再送してお試しください。");
        await claimResult();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "続けられませんでした。もう一度お試しください。"); }
    finally { setBusy(false); }
  }

  async function checkBeforeConfirm(sessionId: string) {
    if (!terms || !startConsent || !claim || preview.sample) throw new Error("利用規約と、営業を開始する内容をご確認ください。");
    setFinancialBusy(true);
    const latest = await getPreview(preview.id);
    if (latest.status !== "claimed" || latest.claimedProjectId !== claim.projectId) throw new Error("保存した内容を確認できませんでした。もう一度開いてお試しください。");
    await consentPreview(preview.id, crypto.randomUUID(), sessionId);
  }

  async function finishPayment() {
    if (checkingPayment.current || preview.sample || !startConsent || !terms) return;
    checkingPayment.current = true; setPaymentState("waiting"); setComplete(true); setError("");
    try {
      if (returning) {
        const pending = (await readBilling()).pendingPreviewSessions?.[preview.id];
        if (!pending?.sessionId) throw new Error("この準備に対応する決済を確認できません。追加で支払わず、管理画面でご確認ください。");
        await consentPreview(preview.id, crypto.randomUUID(), pending.sessionId);
      }
      for (let attempt = 0; attempt < 15; attempt++) {
        const billing = await readBilling();
        const pending = billing.pendingPreviewSessions?.[preview.id], verified = billing.verifiedPreviewSessions?.[preview.id];
        const mode = plan === "prepaid" ? "payment" : "setup", amountMinor = plan === "prepaid" ? amount : 0;
        const matches = pending && verified && pending.sessionId === verified.sessionId && pending.mode === mode && verified.mode === mode && pending.amountMinor === amountMinor && verified.amountMinor === amountMinor && pending.currency === "JPY" && verified.currency === "JPY";
        if (matches && billing.paymentStatus === "verified" && billing.billingConfigured && billing.currency === "JPY") {
          if (!startRequestId.current) startRequestId.current = crypto.randomUUID();
          const started = await startPreview(preview.id, startRequestId.current);
          setStartedUrl(started.redirectUrl); setPaymentState("started"); return;
        }
        if (attempt < 14) await new Promise(resolve => setTimeout(resolve, 2000));
      }
      setPaymentState("pending");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "営業の開始状況を確認できませんでした。"); setPaymentState("pending"); }
    finally { checkingPayment.current = false; }
  }

  return <Dialog.Root open={open} onOpenChange={next => { if (!financialBusy || complete) onOpenChange(next); }}><Dialog.Portal><Dialog.Overlay className="pv-checkout-overlay" /><Dialog.Content className="pv-checkout" aria-describedby="pv-checkout-description">
    <div className="pv-sheet-handle" aria-hidden="true" />
    <Dialog.Title className="pv-visually-hidden">営業メールの利用プランを選ぶ</Dialog.Title>
    <Dialog.Description id="pv-checkout-description" className="pv-visually-hidden">前払いまたは従量払いを選び、メールアドレスの本人確認後に支払方法を登録します。サンプル候補は送信できません。</Dialog.Description>
    <Dialog.Close className="pv-modal-close" disabled={financialBusy && !complete} aria-label="プラン選択を閉じる"><X size={20} /></Dialog.Close>
    <div className="pv-checkout-plans">
      {preview.sample && <span className="pv-sample-badge">サンプルのプラン画面</span>}
      <button className={`pv-plan-choice ${plan === "prepaid" ? "is-selected" : ""}`} disabled={planLocked} onClick={() => setPlan("prepaid")} aria-pressed={plan === "prepaid"}><span className="pv-radio-dot" /><strong>{yen(amount)}のお支払いで、<span>{yen(amount * multiplier)}</span>分</strong></button>
      <p className="pv-refund-copy">初回前払い後に1,000通送信し、7日後も好意的な返信がなければ、初回入金の全額返金を申請できます。<Link href="/info/terms">返金条件</Link></p>
      <div className="pv-topup-options">{TOPUPS.map(value => <button key={value} className={plan === "prepaid" && amount === value ? "is-selected" : ""} disabled={planLocked} onClick={() => { setPlan("prepaid"); setAmount(value); }} aria-pressed={plan === "prepaid" && amount === value}><strong>{yen(value)} <ArrowRight size={13} /> <span>{yen(value * multiplier)}</span></strong><small>{(value * multiplier / 6).toLocaleString("ja-JP")}通分</small></button>)}</div>
      <div className="pv-payg"><button className={`pv-plan-choice ${plan === "usage" ? "is-selected" : ""}`} disabled={planLocked} onClick={() => setPlan("usage")} aria-pressed={plan === "usage"}><span className="pv-radio-dot" /><strong>使った分だけお支払い</strong></button><p>前払いなし。営業メール1通6円、返信は無料です。</p></div>
      <div className="pv-price-explanation"><Gift size={22} /><div><h3>{plan === "prepaid" ? bonusEligible === false ? "前払いで利用クレジットを追加" : "初回の前払いが2倍に" : bonusEligible === false ? "使った分だけお支払い" : "4,500円分から始める"}</h3><p>{plan === "prepaid" ? `${yen(amount)}で${yen(amount * multiplier)}の利用クレジット。以降は1通6円で、いつでも停止できます。` : bonusEligible === false ? "ご登録の支払方法と利用クレジットで継続します。利用枠は管理画面で確認できます。" : "カード確認後に4,500円分の無料枠を付与。以降は使った分だけのお支払いです。"}</p><small>無料枠と初回前払い2倍は併用できません。</small></div></div>
      <div className="pv-payment-assurance"><ShieldCheck size={17} /><span>月額契約なし。日額・月額の上限を設定できます。</span></div>
    </div>
    <div className="pv-checkout-details">
      {!billingAllowed ? <div className="pv-sample-checkout"><div className="pv-checkout-symbol"><Mail size={27} /></div><h2>{preview.sample ? "営業の流れを確認できました。" : "送信できる顧客データが必要です。"}</h2><p>{preview.sample ? "表示している候補とメールは架空のサンプルです。実際のお客様のデータを取り込んでから、支払方法と送信内容を確認できます。" : "現在の条件では、送信できる連絡先とメールがまだ揃っていません。顧客データとキャンペーンの条件を確認してください。"}</p><div className="pv-sample-notice"><LockKeyhole size={18} /><span>{preview.sample ? "サンプルではカード登録・課金・メール送信はできません。" : "送信候補が準備されるまで、カード登録・課金・メール送信は行いません。"}</span></div><Link className="pv-primary" href="/app/leads">実データを準備する<ArrowRight size={16} /></Link><button className="pv-text-button" onClick={() => onOpenChange(false)}>候補とメールの例に戻る</button></div>
        : complete ? <div className="pv-sample-checkout"><div className="pv-checkout-symbol">{paymentState === "waiting" ? <LoaderCircle size={28} className="pv-spin" /> : <Check size={28} />}</div><h2>{paymentState === "started" ? "営業を開始しました。" : returning ? "決済結果を確認して再開" : "支払情報を受け付けました。"}</h2><p role="status">{paymentState === "started" ? "確認した宛先とメールを、設定した条件と予算の範囲で送信します。管理画面で状況を確認できます。" : paymentState === "waiting" ? "決済結果を確認しています。反映後、確認した内容で営業を開始します。" : "決済結果の反映、または営業の開始条件の確認が必要です。二重に支払う必要はありません。"}</p>{error && <p className="pv-error" role="alert">{error}</p>}{returning && paymentState !== "started" && <div><label className="pv-terms"><input type="checkbox" checked={terms} disabled={paymentState === "waiting"} onChange={event => setTerms(event.target.checked)} /><span><Link href="/info/terms" target="_blank">利用規約</Link>と<Link href="/info/privacy" target="_blank">プライバシー</Link>に同意します。</span></label><label className="pv-terms"><input type="checkbox" checked={startConsent} disabled={paymentState === "waiting"} onChange={event => setStartConsent(event.target.checked)} /><span>保存済みの宛先と文面で初回・追客メールの送信と、設定に従った返信対応を開始します。</span></label></div>}{paymentState === "pending" && <button className="pv-primary" disabled={!terms || !startConsent} onClick={() => void finishPayment()}>反映を確認して営業を開始<ArrowRight size={16} /></button>}<Link href={startedUrl || claim?.redirectUrl || "/app/billing"} className={paymentState === "started" ? "pv-primary" : "pv-text-button"}>管理画面で状況を確認<ArrowRight size={16} /></Link></div>
          : <><h2>{returning ? "決済結果を確認して再開" : claim ? "支払方法を確認" : "準備した内容を保存して続ける"}</h2><p className="pv-checkout-subtitle">{claim ? "安全な決済フォームで支払方法を登録します。" : "画面を離れずにメールアドレスを確認します。"}</p>
            {!claim && <form className="pv-auth-form" onSubmit={submit}>{verified ? <p className="pv-verified-email"><Check size={16} />{session?.user.email}</p> : <><label htmlFor="pv-checkout-email">メールアドレス<input id="pv-checkout-email" type="email" autoComplete="email" required value={email} disabled={sent || busy} onChange={event => setEmail(event.target.value)} placeholder="you@company.com" /></label>{sent && <><p className="pv-field-hint">届いた6桁のコードを入力してください。5分間有効です。</p><label htmlFor="pv-checkout-otp">認証コード<input id="pv-checkout-otp" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={otp} onChange={event => setOtp(event.target.value.replace(/\D/g, ""))} /></label><button className="pv-text-button" type="button" disabled={busy} onClick={() => { setSent(false); setOtp(""); setError(""); }}>メールアドレスを変更・コードを再送</button></>}</>}
              <button className="pv-primary" disabled={busy}>{busy ? <LoaderCircle size={17} className="pv-spin" /> : verified ? returning ? "支払済みの準備を再開" : "このアカウントに結果を保存" : sent ? "確認して支払方法へ" : "認証コードを送る"}{!busy && <ArrowRight size={16} />}</button></form>}
            {claim && !returning && <EmbeddedCheckout key={`${plan}-${amount}`} mode={plan === "prepaid" ? "payment" : "setup"} amountMinor={plan === "prepaid" ? amount : undefined} previewRunId={preview.id} disabled={!terms || !startConsent} onBeforeConfirm={checkBeforeConfirm} confirmLabel="確認して営業を開始" onComplete={() => void finishPayment()} onResumeRequired={() => void resumeConfirmedPayment()} onError={message => { setError(message); setFinancialBusy(false); }} />}
            {error && <p className="pv-error" role="alert">{error}</p>}
            <label className="pv-terms"><input type="checkbox" disabled={financialBusy} checked={terms} onChange={event => setTerms(event.target.checked)} /><span><Link href="/info/terms" target="_blank">利用規約</Link>と<Link href="/info/privacy" target="_blank">プライバシーポリシー</Link>に同意します。</span></label><label className="pv-terms"><input type="checkbox" disabled={financialBusy} checked={startConsent} onChange={event => setStartConsent(event.target.checked)} /><span>選択したキャンペーンの宛先と保存済みの文面を確認し、決済確認後に初回・追客メールの送信と、設定に従った返信対応を開始します。</span></label><p className="pv-field-hint">本人確認と保存だけでは送信しません。上の確認と「確認して営業を開始」の操作後に開始します。</p><div className="pv-secure-payment"><CreditCard size={15} />Stripeによる安全な決済</div>
          </>}
    </div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
