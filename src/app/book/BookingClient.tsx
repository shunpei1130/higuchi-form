"use client";

import Link from "next/link";
import { CalendarDays, Check, Clock3, Globe2, LoaderCircle, MapPin } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BookingDay, BookingReceipt, PublicBookingPage } from "@/lib/higuchi/booking/types";

const showDate = (date: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "full", timeStyle: "short" }).format(new Date(date));
type ManagedPage = { booking: BookingReceipt; days: BookingDay[] };

export function BookingClient({ token, management = false }: { token: string; management?: boolean }) {
  const [page, setPage] = useState<PublicBookingPage | null>(null);
  const [managed, setManaged] = useState<ManagedPage | null>(null);
  const [receipt, setReceipt] = useState<BookingReceipt | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selectedDay, setSelectedDay] = useState("");
  const [selectedSlot, setSelectedSlot] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [changing, setChanging] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const pendingRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const endpoint = `/api/booking/${management ? "manage/" : ""}${encodeURIComponent(token)}`;
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    void fetch(endpoint, { cache: "no-store", signal: controller.signal }).then(async (response) => { const value = await response.json(); if (!response.ok) throw new Error(value.error || "予約ページを開けませんでした。"); if (management) setManaged(value as ManagedPage); else setPage(value as PublicBookingPage); }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "予約ページを開けませんでした。"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [endpoint, management]);
  const submit = async (action: "book" | "reschedule" | "cancel") => {
    setBusy(true); setError("");
    const payload = action === "book" ? { startsAt: selectedSlot, guestName: name, email } : { action, ...(action === "reschedule" ? { startsAt: selectedSlot } : {}), version: managed?.booking.version };
    const fingerprint = JSON.stringify(payload);
    if (pendingRequest.current?.fingerprint !== fingerprint) pendingRequest.current = { fingerprint, id: crypto.randomUUID() };
    try {
      const response = await fetch(endpoint, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, requestId: pendingRequest.current.id }) });
      const value = await response.json(); if (!response.ok) throw new Error(value.error || "予約を処理できませんでした。");
      setReceipt(value as BookingReceipt); setChanging(false); setConfirmCancel(false);
      if (management) setManaged((current) => current ? { ...current, booking: value as BookingReceipt } : current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "通信できませんでした。同じ内容でもう一度お試しください。"); }
    finally { setBusy(false); }
  };
  const days = management ? managed?.days ?? [] : page?.days ?? [];
  const day = days.find((item) => item.date === selectedDay) ?? days[0];
  const selected = day?.slots.find((slot) => slot.startsAt === selectedSlot);
  const event = managed?.booking ?? page;
  const submitForm = (event: FormEvent) => { event.preventDefault(); void submit(management ? "reschedule" : "book"); };
  return <div className="bk-wrap"><Link href="/" className="bk-brand"><img src="/higuchi-mark.svg" width={18} height={28} alt="" />higuchi-form</Link><section className="bk-card">
    {loading ? <div className="bk-center" role="status"><LoaderCircle className="bk-spin" size={28} /><p>予約ページを開いています</p></div> : !event ? <div className="bk-center"><h1>予約ページを開けませんでした</h1><p role="alert">{error || "予約リンクを確認し、担当者にご連絡ください。"}</p></div> : <><aside className="bk-intro"><span className="bk-label">商談の予約</span><h1>{event.title}</h1><p className="bk-host">{event.hostName}</p><ul><li><Clock3 size={17} />{page?.durationMinutes ?? 30}分</li><li><Globe2 size={17} />日本時間（JST）</li><li><MapPin size={17} />{event.locationText}</li></ul><p className="bk-footnote">こちらのページでは、higuchi-form内で管理する予約枠を表示しています。</p></aside><div className="bk-content">{error && <p className="bk-error" role="alert">{error}</p>}
      {receipt && !changing ? <div className="bk-result"><span className="bk-success-icon"><Check size={24} /></span><h2>{receipt.status === "cancelled" ? "予約を取り消しました" : management ? "予約の日時を変更しました" : "予約が確定しました"}</h2><p>{showDate(receipt.startsAt)}</p><p>{receipt.guestName}様</p><p className="bk-description">確認メールをお送りします。届かない場合は担当者にご連絡ください。</p>{receipt.status === "booked" && <a className="bk-primary" href={receipt.manageUrl}>予約の確認・変更</a>}</div> : management && managed && !changing ? <><h2>{managed.booking.status === "cancelled" ? "この予約は取り消されています" : "予約内容の確認"}</h2><div className="bk-summary"><CalendarDays size={20} /><div><strong>{showDate(managed.booking.startsAt)}</strong><p>{managed.booking.guestName}様 · {managed.booking.guestEmail}</p></div></div>{managed.booking.locationUrl && <a className="bk-primary" href={managed.booking.locationUrl} target="_blank" rel="noreferrer">参加URLを開く</a>}{managed.booking.canChange && !confirmCancel && <div className="bk-actions"><button className="bk-primary" onClick={() => { setChanging(true); setSelectedSlot(""); }}>日時を変更</button><button className="bk-secondary" onClick={() => setConfirmCancel(true)}>予約を取り消す</button></div>}{confirmCancel && <div className="bk-cancel"><p>この予約を取り消しますか？</p><div className="bk-actions"><button className="bk-secondary" disabled={busy} onClick={() => setConfirmCancel(false)}>戻る</button><button className="bk-danger" disabled={busy} onClick={() => void submit("cancel")}>{busy ? "処理中…" : "取り消す"}</button></div></div>}{!managed.booking.canChange && managed.booking.status === "booked" && <p className="bk-description">開始済みの予約はこの画面から変更できません。担当者にご連絡ください。</p>}</> : page?.booked ? <div className="bk-center"><CalendarDays size={30} /><h2>すでに予約が確定しています</h2><p>確認メールにある予約の確認・変更リンクをご利用ください。</p></div> : <><h2>{management ? "変更後の日時を選択" : "ご希望の日時を選択"}</h2><p className="bk-description">24時間後から30日先まで予約できます。</p>{days.length ? <form onSubmit={submitForm}><label className="bk-field">日付<select value={day?.date ?? ""} onChange={(event) => { setSelectedDay(event.target.value); setSelectedSlot(""); }}>{days.map((item) => <option key={item.date} value={item.date}>{item.label}</option>)}</select></label><fieldset className="bk-slots"><legend>開始時刻（日本時間）</legend>{day?.slots.map((slot) => <button key={slot.startsAt} type="button" className={selectedSlot === slot.startsAt ? "is-selected" : ""} aria-pressed={selectedSlot === slot.startsAt} onClick={() => setSelectedSlot(slot.startsAt)}>{slot.label}</button>)}</fieldset>{selected && <><div className="bk-chosen"><Check size={16} />{showDate(selected.startsAt)}</div>{!management && <><label className="bk-field">お名前<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} autoComplete="name" /></label><label className="bk-field">ご案内を受け取ったメールアドレス<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} autoComplete="email" /></label></>}<button className="bk-primary bk-full" disabled={busy} type="submit">{busy ? <><LoaderCircle size={17} className="bk-spin" />処理中…</> : management ? "この日時に変更する" : "この内容で予約を確定"}</button><p className="bk-description">確定後、確認メールをお送りします。日時の変更・取消は確認メールから行えます。</p></>}</form> : <div className="bk-empty"><p>現在、予約できる日時がありません。担当者にご連絡ください。</p></div>}{management && <button className="bk-secondary" style={{ marginTop: 18 }} onClick={() => setChanging(false)}>予約内容に戻る</button>}</>}
    </div></>}
  </section><footer className="bk-footer"><Link href="/info/privacy">プライバシー</Link><span>予約の時刻はすべて日本時間です</span></footer></div>;
}
