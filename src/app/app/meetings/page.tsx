"use client";
import { useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import Link from "next/link";
import { Card, EmptyState, PageHeader, Status, dateTime } from "@/components/higuchi/ui";
import { useProject, useWorkspace } from "@/components/higuchi/workspace";
import type { BookingReceipt } from "@/lib/higuchi/booking/types";
export default function MeetingsPage() {
  const { data } = useWorkspace(); const project = useProject();
  const [meetings, setMeetings] = useState<BookingReceipt[]>([]), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  useEffect(() => { if (!data || data.mode === "simulation") { setLoading(false); return; } const controller = new AbortController(); void fetch("/api/booking/meetings", { cache: "no-store", signal: controller.signal }).then(async (response) => { const value = await response.json(); if (!response.ok) throw new Error(value.error || "予約を取得できませんでした。"); setMeetings(value.meetings); }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "予約を取得できませんでした。"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, [data?.mode]);
  if (!data) return null;
  const simulated = data.meetings.filter((meeting) => meeting.projectId === project?.id);
  return <><PageHeader eyebrow="商談予約" title="次の商談を、ひと目で。" description="予約・日程変更・取消を確認できます。表示時刻は日本時間です。" actions={<Link className="hf-button hf-button-secondary" href="/app/settings">予約ページの設定</Link>} />{error && <p className="hf-alert" role="alert">{error}</p>}<Card>{loading ? <p className="hf-card-padding hf-subtle">予約を読み込んでいます…</p> : data.mode === "simulation" ? simulated.length ? <div className="hf-table-wrap"><table><thead><tr><th>日時</th><th>顧客</th><th>状態</th></tr></thead><tbody>{simulated.map((meeting) => <tr key={meeting.id}><td>{dateTime(meeting.startsAt)}</td><td>{data.leads.find((lead) => lead.id === meeting.leadId)?.name || "顧客"}</td><td><Status value={meeting.status} /><small>シミュレーション</small></td></tr>)}</tbody></table></div> : <EmptyState icon={<CalendarDays size={25} />} title="まだ予約がありません" description="管理画面のシミュレーション操作から、商談予約を再現できます。" /> : meetings.length ? <div className="hf-table-wrap"><table><thead><tr><th>日時</th><th>予約者</th><th>状態</th><th /></tr></thead><tbody>{meetings.map((meeting) => <tr key={meeting.id}><td><strong>{dateTime(meeting.startsAt)}</strong><small>30分 · {meeting.title}</small></td><td><strong>{meeting.guestName}</strong><small>{meeting.guestEmail}</small></td><td><Status value={meeting.status} /></td><td><a className="hf-text-link" href={meeting.manageUrl}>確認・変更</a></td></tr>)}</tbody></table></div> : <EmptyState icon={<CalendarDays size={25} />} title="まだ予約がありません" description="顧客が予約リンクから日時を選ぶと、ここに表示されます。" />}</Card></>;
}
