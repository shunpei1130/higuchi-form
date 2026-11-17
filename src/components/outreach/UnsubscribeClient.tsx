"use client";

import { useState } from "react";

export default function UnsubscribeClient({ token }: { token: string | null }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleUnsubscribe() {
    if (!token) return;
    setState("loading");
    try {
      const res = await fetch("/api/outreach/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "配信停止を完了できませんでした。");
        setState("error");
        return;
      }
      setEmail(data.email);
      setState("done");
    } catch {
      setError("通信に失敗しました。もう一度お試しください。");
      setState("error");
    }
  }

  if (!token) {
    return (
      <div className="text-center">
        <h1 className="text-lg font-bold text-text-strong-950">リンクを確認してください</h1>
        <p className="text-sm text-text-strong-950/50 mt-2">配信停止に必要な情報がありません。メール内のリンクを開き直してください。</p>
      </div>
    );
  }

  if (state === "done") {
    return (
      <div className="text-center">
        <div className="w-12 h-12 rounded-full bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-emerald-600 dark:text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </div>
        <h1 className="text-lg font-bold text-text-strong-950">配信を停止しました</h1>
        <p className="text-sm text-text-strong-950/50 mt-2">
          {email} への今後の営業メールを停止しました。
        </p>
      </div>
    );
  }

  return (
    <div className="text-center">
      <h1 className="text-lg font-bold text-text-strong-950">メールの配信停止</h1>
      <p className="text-sm text-text-strong-950/50 mt-2 mb-6">
        この送信元からの営業メールを停止するには、下のボタンを押してください。
      </p>
      {error && <p className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2 mb-4">{error}</p>}
      <button
        onClick={handleUnsubscribe}
        disabled={state === "loading"}
        className="w-full h-10 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 disabled:opacity-50 transition-colors"
      >
        {state === "loading" ? "停止しています…" : "配信を停止する"}
      </button>
    </div>
  );
}
