"use client";

import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, Globe2, LoaderCircle, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Card, InlineNote, Status } from "@/components/higuchi/ui";
import { useWorkspace } from "@/components/higuchi/workspace";
import { shouldProposeProject } from "@/components/higuchi/liveUpdates";

export default function ProjectOnboardingPage() {
  const { data, perform, busy } = useWorkspace();
  const [mode, setMode] = useState<"website" | "description">("website");
  const [website, setWebsite] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icp, setIcp] = useState("");
  const [geo, setGeo] = useState("日本");
  const [createdId, setCreatedId] = useState("");
  const [proposalFailed, setProposalFailed] = useState(false);
  const proposalAttempted = useRef(new Set<string>());
  const created = data?.projects.find(project => project.id === createdId) ?? null;
  const [step, setStep] = useState<"input" | "analyzing" | "complete">("input");
  const autoStarted = useRef(false);
  useEffect(() => { const params = new URLSearchParams(window.location.search); if (params.has("website")) setWebsite(params.get("website") ?? ""); if (params.has("description")) { setMode("description"); setDescription(params.get("description") ?? ""); } if (params.has("icp")) setIcp(params.get("icp") ?? ""); if (params.has("geo")) setGeo(params.get("geo") ?? "日本"); if (params.has("project")) { setCreatedId(params.get("project") || ""); setStep("analyzing"); } }, []);
  const createProject = async (values: { website: string; name: string; description: string; icp: string; geo: string }) => {
    setStep("analyzing");
    setProposalFailed(false);
    const sourceName = values.name || (() => { try { return new URL(values.website.includes("://") ? values.website : `https://${values.website}`).hostname.replace(/^www\./, ""); } catch { return values.description.slice(0, 32) || "新しいプロジェクト"; } })();
    const snapshot = await perform({ type: "project.create", name: sourceName, website: values.website || undefined, description: values.description || undefined, icp: values.icp || undefined, geography: values.geo || undefined });
    if (!snapshot) { setStep("input"); return; }
    const project = snapshot.projects.find((item) => item.id === snapshot.activeProjectId) ?? snapshot.projects.at(-1);
    if (!project) { setStep("input"); return; }
    setCreatedId(project.id);
    const url = new URL(window.location.href); url.searchParams.set("project", project.id); url.searchParams.delete("start"); window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  };
  const propose = useCallback(async (projectId: string) => {
    proposalAttempted.current.add(projectId); setProposalFailed(false);
    const result = await perform({ type: "campaign.propose", projectId });
    setProposalFailed(!result); setStep("complete");
  }, [perform]);
  useEffect(() => {
    if (!data) return;
    if (createdId && !created) { setStep("input"); return; }
    if (!created) return;
    if (created.status === "needs_setup") { setStep("complete"); return; }
    if (created.status !== "ready") return;
    if (data.campaigns.some(campaign => campaign.projectId === created.id)) { setStep("complete"); return; }
    if (shouldProposeProject(created, data.campaigns) && !proposalAttempted.current.has(created.id)) void propose(created.id);
  }, [createdId, created, data, propose]);
  useEffect(() => {
    if (!data || autoStarted.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("start") !== "1" || (!params.get("website") && !params.get("description"))) return;
    autoStarted.current = true;
    params.delete("start");
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
    void createProject({ name: "", website: params.get("website") ?? "", description: params.get("description") ?? "", icp: params.get("icp") ?? "", geo: params.get("geo") ?? "日本" });
    // The URL is a one-time submitted landing-page intent; subsequent state changes must not repeat it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const submit = (event: FormEvent) => { event.preventDefault(); void createProject({ name, website: mode === "website" ? website : "", description, icp, geo }); };
  const campaigns = data?.campaigns.filter((campaign) => campaign.projectId === created?.id) ?? [];
  return <div className="hf-onboarding"><Link href="/app" className="hf-back"><ArrowLeft size={13} />ワークスペースに戻る</Link><div className="hf-onboarding-top"><p className="hf-step-label">事業を設定</p><h1>{step === "complete" ? created?.status === "ready" && campaigns.length ? "営業の準備が整いました。" : created?.status === "ready" ? "事業の解析が完了しました。" : "事業情報を確認してください。" : "あなたの事業を教えてください。"}</h1><p className="hf-description">{step === "complete" ? "顧客像とキャンペーンを確認して、次のステップへ進みましょう。" : "何を、誰に届けるか。AIエージェントが事業を理解するところから始めます。"}</p></div>
    {step === "input" && <Card><div className="hf-tabs" role="tablist" aria-label="事業の入力方法"><button type="button" role="tab" aria-selected={mode === "website"} onClick={() => setMode("website")}>ウェブサイトから</button><button type="button" role="tab" aria-selected={mode === "description"} onClick={() => setMode("description")}>事業の説明から</button></div><form onSubmit={submit} className="hf-form">{mode === "website" ? <div className="hf-field"><label htmlFor="onboarding-website">会社・サービスのウェブサイト</label><input id="onboarding-website" value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="例: yourcompany.com" autoFocus required inputMode="url" maxLength={2000} /><small>公開されている事業紹介ページのURLを入力してください。</small></div> : <><div className="hf-field"><label htmlFor="onboarding-business">どのような商品・サービスですか？</label><textarea id="onboarding-business" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="例: 中小企業の営業チーム向けに、顧客管理とメール配信を一元化するサービスを提供しています。" required minLength={10} maxLength={10000} rows={4} autoFocus /></div><div className="hf-field"><label htmlFor="onboarding-name">会社・サービス名</label><input id="onboarding-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例: サクラセールス" maxLength={100} /></div></>}<div className="hf-field"><label htmlFor="onboarding-icp">どのようなお客様に届けたいですか？</label><textarea id="onboarding-icp" value={icp} onChange={(event) => setIcp(event.target.value)} placeholder="例: 従業員10〜100名のB2B企業。営業部長や経営者。" required={mode === "description"} rows={3} maxLength={5000} /></div><div className="hf-field"><label htmlFor="onboarding-geo">対象の地域・市場</label><input id="onboarding-geo" value={geo} onChange={(event) => setGeo(event.target.value)} placeholder="例: 日本、東京都、大阪府" maxLength={200} /></div>{data?.mode === "simulation" && <InlineNote kind="warning">シミュレーションでは入力内容からサンプルの営業提案を作成します。実際のウェブ解析や顧客探索は行いません。</InlineNote>}<Button type="submit" busy={busy} className="hf-button-block"><Sparkles size={16} />事業を解析してキャンペーンを提案</Button><p className="hf-subtle" style={{ textAlign: "center" }}>この操作だけで営業メールが送信されることはありません。</p></form></Card>}
    {step === "analyzing" && <Card><div style={{ textAlign: "center", padding: "20px 0" }}><LoaderCircle size={32} className="hf-spin" style={{ margin: "0 auto 20px", color: "#18856a" }} /><h2>事業に合うアプローチを考えています</h2><p className="hf-description">事業内容と顧客像を整理し、営業キャンペーンを準備しています。</p></div><div className="hf-analysis-list"><div><Globe2 size={17} /><div><strong>事業と提供価値を整理</strong><small>入力された情報を確認しています</small></div></div><div><UsersIcon /><div><strong>理想のお客様を定義</strong><small>顧客像に合う営業の切り口を考えます</small></div></div><div><Sparkles size={17} /><div><strong>キャンペーンを提案</strong><small>個別メールの方針を準備します</small></div></div></div></Card>}
    {step === "complete" && created && <Card><div className="hf-row hf-between" style={{ marginBottom: 18 }}><h2>{created.name}</h2><Status value={created.status} label={created.status === "ready" ? "事業設定が完了" : "追加情報が必要"} /></div><p className="hf-description" style={{ marginBottom: 23 }}>{created.description}</p><div className="hf-field" style={{ marginBottom: 23 }}><label>理想のお客様</label><p style={{ fontSize: 12, color: "#7c8d70", whiteSpace: "pre-wrap" }}>{created.icp}</p></div>{created.analysisSources.length > 0 && <div className="hf-source-list" style={{ marginBottom: 24 }}>{created.analysisSources.filter((url) => /^https?:\/\//.test(url)).map((url) => <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}</div>}{proposalFailed && <div style={{ marginBottom: 20 }}><InlineNote kind="warning">事業の解析は完了しましたが、キャンペーンを作成できませんでした。</InlineNote><Button type="button" variant="secondary" busy={busy} style={{ marginTop: 12 }} onClick={() => void propose(created.id)}>キャンペーンの提案を再試行</Button></div>}<div className="hf-stack">{campaigns.map((campaign) => <div className="hf-proposal" key={campaign.id}><div className="hf-row hf-between"><strong>{campaign.name}</strong><Check size={16} /></div><p>{campaign.audience}</p><p>{campaign.objective}</p></div>)}</div><div style={{ margin: "23px 0" }}><InlineNote>顧客データの取得先は未接続です。CSVの取り込み、またはシミュレーション用の顧客を追加してフローを試せます。</InlineNote></div><Link href={created.status === "ready" ? "/app/campaigns" : "/app/settings"} className="hf-button hf-button-primary hf-button-block">{created.status === "ready" ? "キャンペーンを確認" : "事業情報を補完する"}<ArrowRight size={15} /></Link></Card>}
  </div>;
}

function UsersIcon() { return <span style={{ width: 17, height: 17, display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Check size={16} /></span>; }
