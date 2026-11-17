"use client";

import { useEffect, useState, type FormEvent } from "react";
import { CalendarDays, Plus, Trash2 } from "lucide-react";
import { Button, Card, InlineNote, Toggle, dateTime } from "@/components/higuchi/ui";
import { DEFAULT_BOOKING_SETTINGS, type BookingSettings } from "./types";

export function BookingSettingsPanel() {
  const [settings, setSettings] = useState<BookingSettings>(() => structuredClone(DEFAULT_BOOKING_SETTINGS));
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [canEdit, setCanEdit] = useState(false), [simulation, setSimulation] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [blockStart, setBlockStart] = useState(""), [blockEnd, setBlockEnd] = useState(""), [blockLabel, setBlockLabel] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/booking/settings", { cache: "no-store", signal: controller.signal }).then(async (response) => { const value = await response.json(); if (!response.ok) throw new Error(value.error || "予約設定を取得できませんでした。"); setSettings(value.settings); setCanEdit(Boolean(value.canEdit)); setSimulation(Boolean(value.simulation)); }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "予約設定を取得できませんでした。"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  const patch = <K extends keyof BookingSettings>(key: K, value: BookingSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(""); setNotice(""); setBusy(true);
    try { const response = await fetch("/api/booking/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings }) }); const value = await response.json(); if (!response.ok) throw new Error(value.error || "予約設定を保存できませんでした。"); setSettings(value.settings); setNotice("予約設定を保存しました。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "予約設定を保存できませんでした。"); }
    finally { setBusy(false); }
  };
  const addBlock = () => {
    const startsAt = Date.parse(`${blockStart}:00+09:00`), endsAt = Date.parse(`${blockEnd}:00+09:00`);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) { setError("休業時間の開始・終了日時を確認してください。"); return; }
    patch("blocks", [...settings.blocks, { id: crypto.randomUUID(), startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(), label: blockLabel || "休業時間" }]);
    setBlockStart(""); setBlockEnd(""); setBlockLabel(""); setError("");
  };
  return <Card><div className="hf-card-header"><div><h2>内蔵の商談予約ページ</h2><p>外部カレンダーを使わず、higuchi-form内で予約を管理します</p></div><CalendarDays size={18} /></div><form className="hf-card-padding hf-form" onSubmit={submit}>
    {loading ? <p className="hf-subtle">予約設定を読み込んでいます…</p> : <>{simulation && <InlineNote kind="warning">設定項目のプレビューです。本番接続後に公開できます。シミュレーションでは、管理画面の予約再現機能を利用してください。</InlineNote>}{error && <p role="alert" className="hf-alert">{error}</p>}{notice && <InlineNote kind="success">{notice}</InlineNote>}<fieldset disabled={!canEdit || busy} style={{ display: "grid", gap: 18, border: 0, padding: 0, minWidth: 0 }}>
      <Toggle checked={settings.enabled} onChange={(value) => patch("enabled", value)} label="予約の受付を公開する" description="公開すると、営業メールで顧客ごとの予約リンクを案内できます。" disabled={!canEdit || busy} />
      <div className="hf-field"><label htmlFor="booking-event-title">予約ページのタイトル</label><input id="booking-event-title" value={settings.title} onChange={(event) => patch("title", event.target.value)} required maxLength={100} /></div>
      <div className="hf-field"><label htmlFor="booking-host-name">担当者の表示名</label><input id="booking-host-name" value={settings.hostName} onChange={(event) => patch("hostName", event.target.value)} required maxLength={120} /><small>通知先: {settings.hostEmail}</small></div>
      <div className="hf-grid-2"><div className="hf-field"><label htmlFor="booking-start-time">受付開始（日本時間）</label><input id="booking-start-time" type="time" step={900} value={settings.startTime} onChange={(event) => patch("startTime", event.target.value)} required /></div><div className="hf-field"><label htmlFor="booking-end-time">受付終了（日本時間）</label><input id="booking-end-time" type="time" step={900} value={settings.endTime} onChange={(event) => patch("endTime", event.target.value)} required /></div></div>
      <div className="hf-field"><label>受付する曜日</label><div className="hf-weekdays">{["日", "月", "火", "水", "木", "金", "土"].map((label, index) => <button key={label} type="button" aria-pressed={settings.weekdays.includes(index)} onClick={() => patch("weekdays", settings.weekdays.includes(index) ? settings.weekdays.filter((day) => day !== index) : [...settings.weekdays, index].sort())}>{label}</button>)}</div><small>30分の商談、15分刻み、終了後15分の余白。24時間後から30日先まで受け付けます。</small></div>
      <div className="hf-field"><label htmlFor="booking-location-url">参加URL（後から設定できます）</label><input id="booking-location-url" type="url" value={settings.locationUrl} onChange={(event) => patch("locationUrl", event.target.value)} placeholder="https://…" maxLength={2000} /><small>Google Meetなどの参加URLを自動生成する機能はありません。</small></div>
      <div className="hf-field"><label htmlFor="booking-location-text">参加方法の案内</label><input id="booking-location-text" value={settings.locationText} onChange={(event) => patch("locationText", event.target.value)} required maxLength={500} /></div>
      <div className="hf-divider" /><h3>予約を受け付けない時間</h3><InlineNote>外部カレンダーの予定は自動反映されません。休業日や別の予定は、こちらに登録してください。すでに確定した予約は自動取消されません。</InlineNote>
      {settings.blocks.map((block) => <div key={block.id} className="hf-row hf-between"><div><strong style={{ fontSize: 12 }}>{block.label}</strong><p className="hf-subtle">{dateTime(block.startsAt)}〜{dateTime(block.endsAt)}</p></div><button type="button" className="hf-icon-button" aria-label={`${block.label}を削除`} onClick={() => patch("blocks", settings.blocks.filter((item) => item.id !== block.id))}><Trash2 size={15} /></button></div>)}
      <div className="hf-grid-2"><div className="hf-field"><label htmlFor="booking-block-start">開始日時（日本時間）</label><input id="booking-block-start" type="datetime-local" value={blockStart} onChange={(event) => setBlockStart(event.target.value)} /></div><div className="hf-field"><label htmlFor="booking-block-end">終了日時（日本時間）</label><input id="booking-block-end" type="datetime-local" value={blockEnd} onChange={(event) => setBlockEnd(event.target.value)} /></div></div><div className="hf-field"><label htmlFor="booking-block-label">メモ</label><input id="booking-block-label" value={blockLabel} onChange={(event) => setBlockLabel(event.target.value)} placeholder="例: 休業日、別の商談" maxLength={200} /></div><Button variant="secondary" type="button" disabled={!blockStart || !blockEnd} onClick={addBlock}><Plus size={14} />休業時間を追加</Button><p className="hf-subtle">追加・削除した休業時間は、「予約設定を保存」で反映されます。</p>
      <div className="hf-form-actions"><Button type="submit" busy={busy}>予約設定を保存</Button></div>
    </fieldset>{!canEdit && !simulation && <p className="hf-subtle">予約設定の変更は、組織のオーナー・管理者が行えます。</p>}</>}
  </form></Card>;
}
