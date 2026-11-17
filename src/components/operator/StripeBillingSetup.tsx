"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

type StripeBillingSetupProps = {
  organizationId: string;
  disabled: boolean;
  simulation: boolean;
  onSaved?: () => void;
};

export function StripeBillingSetup({ organizationId, disabled, simulation, onSaved }: StripeBillingSetupProps) {
  const formId = useId();
  const [origin, setOrigin] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [subscriptionId, setSubscriptionId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestSequence = useRef(0);
  const blocked = disabled || simulation || expired || saving || !organizationId;

  useEffect(() => { setOrigin(window.location.origin); }, []);
  useEffect(() => {
    requestSequence.current++;
    setCustomerId("");
    setSubscriptionId("");
    setConfirmed(false);
    setSaving(false);
    setError("");
    setNotice("");
    return () => { requestSequence.current++; };
  }, [organizationId]);

  async function saveMapping(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked) return;
    setError("");
    setNotice("");
    const customer = customerId.trim();
    const subscription = subscriptionId.trim();
    if (!/^cus_[a-zA-Z0-9]+$/.test(customer)) {
      setError("この組織に対応するStripe顧客ID（cus_で始まる値）を入力してください。");
      return;
    }
    if (subscription && !/^sub_[a-zA-Z0-9]+$/.test(subscription)) {
      setError("Stripe契約IDはsub_で始まる値を入力してください。");
      return;
    }
    if (!confirmed) {
      setError("この組織のhiguchi-form専用IDであることを確認してください。");
      return;
    }
    const sequence = ++requestSequence.current;
    setSaving(true);
    try {
      const response = await fetch("/api/higuchi/admin", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "billing.save",
          organizationId,
          credentials: { stripeCustomerId: customer, ...(subscription ? { stripeSubscriptionId: subscription } : {}) },
        }),
      });
      const data: unknown = await response.json().catch(() => null);
      if (sequence !== requestSequence.current) return;
      if (response.status === 401) {
        setExpired(true);
        throw new Error("ログインの有効期限が切れました。再度ログインしてください。");
      }
      if (response.status === 403) throw new Error("この設定を変更できるのは運営管理者のみです。");
      if (!response.ok) {
        const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "対応する顧客・契約を保存できませんでした。設定を確認してください。";
        throw new Error(message);
      }
      setCustomerId("");
      setSubscriptionId("");
      setConfirmed(false);
      setNotice("顧客・契約の対応を保存し、入力欄を消去しました。テスト環境で決済通知と残高の反映を確認してください。");
      onSaved?.();
    } catch (caught) {
      if (sequence === requestSequence.current) setError(caught instanceof Error ? caught.message : "保存できませんでした。しばらくして再度お試しください。");
    } finally {
      if (sequence === requestSequence.current) setSaving(false);
    }
  }

  return <section className="op-card" aria-labelledby={`${formId}-heading`}>
    <h2 id={`${formId}-heading`}>3. Stripeの決済設定</h2>
    <p>Stripeの運営用キーと専用料金は、サービスの公開先で管理します。この画面に秘密キーを入力する必要はありません。通常、顧客は最初のカード登録・前払い時に自動作成されます。</p>
    {simulation && <p className="op-small">シミュレーションでは設定の保存や外部の決済を行いません。</p>}
    <details className="op-details" open>
      <summary>料金と通知先を確認する</summary>
      <p>新規の円建て契約では、初回メール・追客メールは1通6円です。返信メールは無料で、固定月額はありません。</p>
      <p>カード確認後の4,500円無料枠と、初回前払いの残高2倍特典は、どちらか一方を利用できます。無料枠を利用した後は、前払い2倍特典は適用されません。</p>
      <p>従量料金はおおむね750円に達すると請求されます。利用情報の集計により750円を超える場合があり、月末には750円未満の残額も精算されます。</p>
      <p className="op-help">Stripeの通知先は全組織で共通です。署名を確認した通知の顧客IDから対象組織を特定します。</p>
      <code className="op-url" aria-label="Stripeの通知先">{origin}/api/webhooks/stripe</code>
      <p>まずStripeのテスト環境で、カード登録、前払い、通知の受信、残高への反映を確認してください。本番環境への切り替えには、運営用キー・専用料金・通知署名を一式そろえる必要があります。</p>
    </details>
    <details className="op-details">
      <summary>既存の専用顧客をこの組織に関連付ける（通常は不要）</summary>
      <p>この組織のhiguchi-form用として作成済みのIDがある場合だけ入力してください。同じStripeアカウント内の別サービスの顧客や契約は指定しないでください。空欄の項目は保存済みの値を維持します。</p>
      {error && <div className="op-error" role="alert">{error}{expired && <p><Link href="/sign-in?from=%2Foperator">ログイン画面を開く</Link></p>}</div>}
      {notice && <div className="op-success" role="status">{notice}</div>}
      <form autoComplete="off" onSubmit={event => void saveMapping(event)}>
        <fieldset disabled={blocked}>
          <div className="op-fields">
            <div><label htmlFor={`${formId}-customer`}>Stripe顧客ID</label><input id={`${formId}-customer`} value={customerId} onChange={event => setCustomerId(event.target.value)} placeholder="cus_..." maxLength={200} autoComplete="off" spellCheck={false} required /><p className="op-help">選択した組織の専用顧客IDを入力します。</p></div>
            <div><label htmlFor={`${formId}-subscription`}>Stripe契約ID（任意）</label><input id={`${formId}-subscription`} value={subscriptionId} onChange={event => setSubscriptionId(event.target.value)} placeholder="sub_..." maxLength={200} autoComplete="off" spellCheck={false} /><p className="op-help">上の顧客に属する、higuchi-formの従量課金契約のみ指定できます。</p></div>
          </div>
          <label className="op-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} required /><span>この組織のhiguchi-form専用IDで、運営用キーと同じテスト環境・本番環境のものであることを確認しました。</span></label>
          <button className="op-primary" type="submit">{saving ? "保存中…" : "顧客・契約の対応を保存する"}</button>
        </fieldset>
      </form>
    </details>
  </section>;
}
