"use client";

import { CalendarCheck, FlaskConical, Mail, Play } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button, Modal } from "./ui";
import { useProject, useWorkspace } from "./workspace";

export const SAMPLE_CSV = "name,email,company,role,website\n山田 太郎,taro@sakura.example,サクラ商事（サンプル）,営業部長,https://sakura.example\n佐藤 花子,hanako@midori.example,ミドリテック（サンプル）,代表取締役,https://midori.example\n鈴木 健,ken@aoba.example,アオバ企画（サンプル）,事業責任者,https://aoba.example\n高橋 由美,yumi@kaze.example,カゼデザイン（サンプル）,マーケティング部長,https://kaze.example\n田中 誠,makoto@hikari.example,ヒカリサービス（サンプル）,代表取締役,https://hikari.example";

export function SimulationControls({ campaignId }: { campaignId?: string }) {
  const { data, perform, busy } = useWorkspace();
  const project = useProject();
  const [dialog, setDialog] = useState<"reply" | "booking" | null>(null);
  const [leadId, setLeadId] = useState("");
  const [body, setBody] = useState("ご連絡ありがとうございます。興味がありますので、詳しい内容と打ち合わせの予約リンクを送っていただけますか？");
  const [startsAt, setStartsAt] = useState(() => { const value = new Date(Date.now() + 86400000); value.setMinutes(0, 0, 0); return new Date(value.getTime() + 9 * 3600000).toISOString().slice(0, 16); });
  if (data?.mode !== "simulation") return null;
  const leads = data.leads.filter((lead) => lead.projectId === project?.id && (!campaignId || lead.campaignId === campaignId) && lead.status !== "ready" && lead.status !== "suppressed");
  const chosen = leads.some((lead) => lead.id === leadId) ? leadId : leads[0]?.id || "";
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!chosen) return; const result = await perform(dialog === "reply" ? { type: "simulation.reply", leadId: chosen, body, requestId: crypto.randomUUID() } : { type: "simulation.booking", leadId: chosen, startsAt: new Date(`${startsAt}:00+09:00`).toISOString(), requestId: crypto.randomUUID() }); if (result) setDialog(null); };
  return <><div className="hf-simulation-controls"><div><FlaskConical size={16} /><strong>一連の営業フローを試す</strong></div><p>時間を進めると、送信可能なメールと追客・自動返信を処理します。送信後は顧客の返信や商談予約を再現できます。</p><div className="hf-row"><Button variant="secondary" className="hf-button-small" busy={busy} onClick={() => void perform({ type: "simulation.tick", advanceMinutes: 60 })}><Play size={13} />1時間進めて処理</Button><Button variant="secondary" className="hf-button-small" busy={busy} onClick={() => void perform({ type: "simulation.tick", advanceMinutes: 1440 })}>翌日まで進める</Button><Button variant="ghost" className="hf-button-small" disabled={!leads.length || busy} onClick={() => setDialog("reply")}><Mail size={14} />顧客の返信を再現</Button><Button variant="ghost" className="hf-button-small" disabled={!leads.length || busy} onClick={() => setDialog("booking")}><CalendarCheck size={14} />予約を再現</Button></div></div>{dialog && <Modal title={dialog === "reply" ? "顧客からの返信を再現" : "商談予約を再現"} onClose={() => setDialog(null)}><p className="hf-dialog-description">シミュレーション内のイベントを記録します。実際のメールやカレンダーには送信しません。</p><form onSubmit={submit} className="hf-form"><div className="hf-field"><label htmlFor="sim-lead">顧客</label><select id="sim-lead" value={chosen} onChange={(event) => setLeadId(event.target.value)} required>{leads.map((lead) => <option key={lead.id} value={lead.id}>{lead.name} · {lead.company}</option>)}</select></div>{dialog === "reply" ? <div className="hf-field"><label htmlFor="sim-reply">返信内容</label><textarea id="sim-reply" value={body} onChange={(event) => setBody(event.target.value)} required rows={5} /></div> : <div className="hf-field"><label htmlFor="sim-booking">商談の日時（日本時間）</label><input type="datetime-local" id="sim-booking" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} required /></div>}<div className="hf-form-actions"><Button variant="secondary" type="button" onClick={() => setDialog(null)}>キャンセル</Button><Button type="submit" busy={busy}>イベントを記録</Button></div></form></Modal>}</>;
}
