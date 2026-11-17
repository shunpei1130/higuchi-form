"use client";

import Link from "next/link";
import { ArrowUpRight, Bot, CalendarDays, CreditCard, FlaskConical, Mail, Settings } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Project, WorkspaceSettings } from "@/lib/higuchi/types";
import { Button, Card, InlineNote, Modal, PageHeader, Status, Toggle } from "@/components/higuchi/ui";
import { useProject, useWorkspace } from "@/components/higuchi/workspace";
import { BookingSettingsPanel } from "@/lib/higuchi/booking/BookingSettingsPanel";

export default function SettingsPage() {
  const { data, perform, busy } = useWorkspace();
  const project = useProject();
  const [reset, setReset] = useState(false);
  if (!data) return null;
  const integrations = [{ key: "ai" as const, title: "AIエージェント", icon: Bot }, { key: "email" as const, title: "営業メールの送信元", icon: Mail }, { key: "booking" as const, title: "商談予約", icon: CalendarDays }, { key: "billing" as const, title: "利用量課金・決済", icon: CreditCard }];
  return <><PageHeader eyebrow="設定" title="あなたの営業に、合わせる。" description="事業情報、返信ルール、商談の受付時間を確認・変更できます。" /><div className="hf-settings-columns"><div className="hf-stack">{project && <ProjectSettings key={project.id} project={project} />}<ProfileSettings initial={data.settings} /><BookingSettingsPanel /></div><div className="hf-stack" style={{ alignContent: "start" }}><Card><div className="hf-card-header"><div><h2>外部サービスの接続状況</h2><p>接続情報は運営側で管理します</p></div><Settings size={17} color="#819477" /></div><div className="hf-card-padding" style={{ paddingTop: 3, paddingBottom: 7 }}>{integrations.map(({ key, title, icon: Icon }) => <div key={key} className="hf-integration-row"><div className="hf-integration-icon"><Icon size={18} strokeWidth={1.6} /></div><div><strong>{title}</strong><p>{data.integrations[key].detail}</p></div><Status value={data.integrations[key].status} label={data.integrations[key].status === "simulation" ? "模擬" : data.integrations[key].connected ? "接続済み" : "未接続"} /></div>)}</div><div className="hf-card-footer"><Link className="hf-text-link" href="/operator">運営者向け接続設定<ArrowUpRight size={13} /></Link></div></Card><Card><div className="hf-card-padding"><h3>顧客データについて</h3><p className="hf-description">顧客データの取得サービスは、後から選べる構成です。現在はCSVの取り込みをご利用ください。</p><Link className="hf-text-link" href="/app/leads" style={{ marginTop: 14 }}>顧客リストを管理<ArrowUpRight size={13} /></Link></div></Card>{data.mode === "simulation" && <Card><div className="hf-card-padding"><div className="hf-row"><FlaskConical size={17} color="#8da16d" /><h3>シミュレーション</h3></div><p className="hf-description" style={{ marginBottom: 18 }}>このブラウザのシミュレーションデータを初期状態に戻せます。実際の営業データや外部サービスには影響しません。</p><Button variant="danger" className="hf-button-block" disabled={busy} onClick={() => setReset(true)}>シミュレーションをリセット</Button></div></Card>}</div></div>{reset && <Modal title="シミュレーションをリセット" onClose={() => setReset(false)}><p className="hf-dialog-description">このブラウザのプロジェクト、顧客、会話、テスト残高を初期状態に戻します。操作を取り消すことはできません。</p><div className="hf-form-actions"><Button variant="secondary" onClick={() => setReset(false)}>キャンセル</Button><Button variant="danger" busy={busy} onClick={async () => { if (await perform({ type: "simulation.reset" })) setReset(false); }}>リセットする</Button></div></Modal>}</>;
}

function ProjectSettings({ project }: { project: Project }) {
  const { perform, busy } = useWorkspace();
  const [name, setName] = useState(project.name);
  const [website, setWebsite] = useState(project.website);
  const [description, setDescription] = useState(project.description);
  const [icp, setIcp] = useState(project.icp);
  const [geography, setGeography] = useState(project.geography);
  const submit = async (event: FormEvent) => { event.preventDefault(); await perform({ type: "project.update", projectId: project.id, name, website, description, icp, geography }); };
  return <Card><div className="hf-card-header"><h2>プロジェクトの事業情報</h2><Status value={project.status} /></div><form className="hf-card-padding hf-form" onSubmit={submit}><div className="hf-field"><label htmlFor="project-name">会社・サービス名</label><input id="project-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} /></div><div className="hf-field"><label htmlFor="project-website">ウェブサイト</label><input id="project-website" value={website} onChange={(event) => setWebsite(event.target.value)} inputMode="url" placeholder="https://yourcompany.com" maxLength={2000} /></div><div className="hf-field"><label htmlFor="project-description">商品・サービスの説明</label><textarea id="project-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={5} maxLength={10000} /></div><div className="hf-field"><label htmlFor="project-icp">理想のお客様</label><textarea id="project-icp" value={icp} onChange={(event) => setIcp(event.target.value)} rows={4} maxLength={5000} /></div><div className="hf-field"><label htmlFor="project-geography">対象地域</label><input id="project-geography" value={geography} onChange={(event) => setGeography(event.target.value)} maxLength={1000} placeholder="例: 日本、東京都、大阪府"/></div><div className="hf-form-actions"><Button type="submit" busy={busy}>事業情報を保存</Button></div></form></Card>;
}

function ProfileSettings({ initial }: { initial: WorkspaceSettings }) {
  const { perform, busy } = useWorkspace();
  const [settings, setSettings] = useState(initial);
  const patch = <K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => { event.preventDefault(); await perform({ type: "settings.update", settings }); };
  return <Card><div className="hf-card-header"><h2>プロフィール・返信・通知</h2></div><form className="hf-card-padding hf-form" onSubmit={submit}><div className="hf-grid-2"><div className="hf-field"><label htmlFor="display-name">表示名</label><input id="display-name" value={settings.displayName} onChange={(event) => patch("displayName", event.target.value)} maxLength={100} required /></div><div className="hf-field"><label htmlFor="company-name">会社名</label><input id="company-name" value={settings.companyName} onChange={(event) => patch("companyName", event.target.value)} maxLength={150} /></div></div><Toggle checked={settings.autoReply} onChange={(value) => patch("autoReply", value)} label="自動返信を有効にする" description="オンの場合でも、各キャンペーンで自動返信の設定を確認できます。停止・配信停止の状態を優先します。" /><Toggle checked={settings.emailNotifications} onChange={(value) => patch("emailNotifications", value)} label="営業活動のメール通知を受け取る" description="返信やキャンペーン、利用状況などのお知らせを受け取ります。予約の確認・変更・取消は、予約者と担当者に通知します。" /><InlineNote>表示言語は日本語、送信・予約の日時は日本時間です。予算はUTC基準で集計します。</InlineNote><div className="hf-form-actions"><Button type="submit" busy={busy}>設定を保存</Button></div></form></Card>;
}
