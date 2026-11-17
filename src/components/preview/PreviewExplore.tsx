"use client";

import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, Building2, Check, ChevronDown, ExternalLink, Globe2, LoaderCircle, Mail, MessageCircle, Pencil, RefreshCw, Search, Settings2, Sparkles, Target, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PREVIEW_STAGES, type PreviewCampaign, type PreviewSnapshot, type PreviewStage } from "@/lib/higuchi/preview/types";
import { CheckoutModal } from "./CheckoutModal";
import { PreviewResults, type DraftEdit } from "./PreviewResults";
import { PreviewEditModal } from "./PreviewEditModal";
import { usePreview } from "./usePreview";
import "./preview.css";

const STAGE_LABELS: Record<PreviewStage, string> = { company: "あなたの会社を調査", competitors: "競合を調査", campaigns: "キャンペーンを設計", candidates: "顧客候補を探す", verification: "意思決定者を見つける", drafts: "個別メールを作成" };
const STAGE_HINTS: Record<PreviewStage, string> = { company: "公開サイトと事業の説明から、提供価値や理想のお客様を整理します。", competitors: "同じ市場のサービスを調べ、あなたの事業が選ばれる理由を整理します。", campaigns: "事業と顧客像に合う営業の切り口を準備します。", candidates: "キャンペーンの条件に合う企業を、接続済みのデータから絞り込みます。", verification: "会社と役職を確認し、連絡先の検証状態を整理します。", drafts: "候補ごとの会社・役割に合わせた、日本語のメールを準備します。" };
const STAGE_ICONS = { company: Globe2, competitors: Search, campaigns: Target, candidates: Building2, verification: Users, drafts: Mail };
const count = (value: number) => value.toLocaleString("ja-JP");
function safeLink(value: string) { try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.href : undefined; } catch { return undefined; } }
export function domainName(value: string) { try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return value; } }

export function PreviewExplore({ runId }: { runId: string }) {
  const workspace = usePreview(runId);
  const { data, loading, pending, error, fatal, perform } = workspace;
  const [viewedStage, setViewedStage] = useState<PreviewStage | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [competitorsExpanded, setCompetitorsExpanded] = useState(false);
  const [editor, setEditor] = useState<"company" | PreviewCampaign | null>(null);
  const [supportOpen, setSupportOpen] = useState(false);
  const [draftEdits, setDraftEdits] = useState<Record<string, DraftEdit>>({});
  const [unsavedNotice, setUnsavedNotice] = useState(false);
  const [mobileCollapsed, setMobileCollapsed] = useState(false);
  const autoOpened = useRef(false);
  const activeStage = viewedStage || data?.currentStage || "drafts";
  const ready = data?.status === "ready" || data?.status === "claimed";
  const orphanedEdits = Object.entries(draftEdits).filter(([id]) => data && !data.drafts.some(draft => draft.id === id));
  function openEditor(next: "company" | PreviewCampaign) {
    if (Object.keys(draftEdits).length) { setUnsavedNotice(true); setViewedStage("drafts"); setMobileCollapsed(false); return; }
    setEditor(next);
  }
  function openCheckout() {
    if (Object.keys(draftEdits).length) { setUnsavedNotice(true); setViewedStage("drafts"); setMobileCollapsed(false); return; }
    setUnsavedNotice(false); setCheckoutOpen(true);
  }

  useEffect(() => {
    if (!data) return;
    if (data.status === "queued" || data.status === "running") autoOpened.current = false;
    const url = new URL(window.location.href);
    const phase = data.status === "ready" || data.status === "claimed" ? "final" : data.currentStage || "company";
    if (url.searchParams.get("phase") !== phase) { url.searchParams.set("phase", phase); window.history.replaceState(null, "", `${url.pathname}${url.search}`); }
    if (data.status === "ready" && !autoOpened.current) { autoOpened.current = true; setViewedStage("drafts"); setCheckoutOpen(true); }
    if (data.status === "claimed" && url.searchParams.get("billing_return") === "1" && !autoOpened.current) { autoOpened.current = true; setViewedStage("drafts"); setCheckoutOpen(true); }
  }, [data]);
  useEffect(() => {
    if (!Object.keys(draftEdits).length) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draftEdits]);

  if (loading) return <div className="pv-app"><div className="pv-full-state" role="status"><LoaderCircle size={27} className="pv-spin" /><h1>営業の準備を読み込んでいます</h1><p>保存されている調査と進捗を確認しています。</p></div></div>;
  if (!data || fatal) return <div className="pv-app"><div className="pv-full-state"><Search size={30} /><h1>準備状況を開けませんでした</h1><p role="alert">{error || "ページの有効期限、または作成したブラウザーをご確認ください。"}</p><Link className="pv-primary" href="/">会社のURLから始める<ArrowRight size={16} /></Link></div></div>;

  function campaignCard(campaign: PreviewCampaign) {
    return <div key={campaign.id} className={`pv-campaign-card ${data?.selectedCampaignId === campaign.id ? "is-selected" : ""}`}><button disabled={pending} className="pv-campaign-select" onClick={() => void perform({ type: "select_campaign", campaignId: campaign.id })} aria-pressed={data?.selectedCampaignId === campaign.id}><Target size={15} /><span>{campaign.name}</span><small>{campaign.estimatedLeads === null ? "—" : count(campaign.estimatedLeads)}</small></button><button className="pv-campaign-edit" aria-label={`${campaign.name}を編集`} onClick={() => openEditor(campaign)} disabled={!data?.capabilities.canEdit}><Pencil size={12} /></button></div>;
  }

  return <div className="pv-app">
    <aside className="pv-sidebar" aria-label="会社とキャンペーンの調査結果">
      <Link href="/" className="pv-wordmark"><img src="/higuchi-mark.svg" alt="" width={14} height={21} /><span>higuchi-form</span></Link>
      <div className="pv-sidebar-content">
        <div className="pv-sidebar-stage"><span className="pv-stage-check">{data.stages[0]?.status === "completed" ? <Check size={13} /> : <span>1</span>}</span><span>会社を調査</span><button aria-label="会社情報を編集" onClick={() => openEditor("company")} disabled={!data.company || !data.capabilities.canEdit}><Settings2 size={15} /></button></div>
        {data.company ? <><div className="pv-company-heading"><span className="pv-company-icon"><Building2 size={21} /></span><div><h1>{data.company.name}</h1>{safeLink(data.company.website) && <a href={safeLink(data.company.website)} target="_blank" rel="noreferrer">{domainName(data.company.website)}<ExternalLink size={11} /></a>}</div><span className="pv-found"><Check size={11} />確認</span></div><p className="pv-sidebar-summary">{data.company.summary || data.company.business}</p><div className="pv-sidebar-meta"><span>理想のお客様</span><p>{data.company.customer}</p><span>対象の地域</span><p>{data.company.geography}</p></div></> : <p className="pv-sidebar-pending">会社の事業内容を調査しています。</p>}
        <div className="pv-sidebar-stage"><span className="pv-stage-check">{data.stages[1]?.status === "completed" ? <Check size={13} /> : <span>2</span>}</span><span>競合を調査</span></div>
        <div className="pv-section-label">競合サービス <span>{data.competitors.length || "—"}</span></div><div className="pv-competitor-chips">{data.competitors.slice(0, competitorsExpanded ? undefined : 8).map(item => <a key={item.website || item.name} href={safeLink(item.website)} title={item.description} target="_blank" rel="noreferrer"><Building2 size={13} /><span>{domainName(item.website) || item.name}</span><ExternalLink size={10} /></a>)}</div>{data.competitors.length > 8 && <button className="pv-more-button" onClick={() => setCompetitorsExpanded(value => !value)}><ChevronDown size={12} className={competitorsExpanded ? "pv-rotate" : ""} />{competitorsExpanded ? "折りたたむ" : `さらに${data.competitors.length - 8}件`}</button>}
        {!data.competitors.length && <p className="pv-sidebar-pending">{data.stages[1]?.status === "completed" ? "公開情報から競合を特定できませんでした。" : "調査した競合がここに表示されます。"}</p>}
        <div className="pv-sidebar-stage"><span className="pv-stage-check">{data.stages[2]?.status === "completed" ? <Check size={13} /> : <span>3</span>}</span><span>キャンペーンを設計</span></div>
        <div className="pv-section-label">キャンペーン <span>{data.campaigns.length || "—"}</span></div><div className="pv-campaign-list">{data.campaigns.map(campaignCard)}</div>{!data.campaigns.length && <p className="pv-sidebar-pending">事業と顧客像から準備しています。</p>}
        {PREVIEW_STAGES.slice(3).map((stage, index) => <div className="pv-sidebar-stage" key={stage}><span className="pv-stage-check">{data.stages.find(item => item.stage === stage)?.status === "completed" ? <Check size={13} /> : <span>{index + 4}</span>}</span><span>{STAGE_LABELS[stage]}</span></div>)}
      </div>
      <div className="pv-sidebar-footer"><Link href="/">別の会社を調べる<ArrowRight size={12} /></Link><span>この準備は24時間保存されます</span></div>
    </aside>

    <main className="pv-main">
      <div className={`pv-offer-bar ${ready ? "is-ready" : ""}`}><div><GiftIcon /><span><strong>4,500円分の無料枠で、次のお客様へ。</strong><small>月額契約なし · 営業メール750通分 · 返信は無料</small></span></div><button className="pv-primary" disabled={!ready} onClick={openCheckout}>{ready ? "営業を始める" : "営業の準備中"}{ready ? <ArrowRight size={17} /> : <LoaderCircle size={16} className="pv-spin" />}</button></div>
      <nav className="pv-desktop-stepper" aria-label="営業の準備工程"><div className="pv-current-steps">{PREVIEW_STAGES.map((stage, index) => { const state = data.stages.find(item => item.stage === stage); return <button key={stage} className={`${state?.status === "completed" ? "is-complete" : ""} ${activeStage === stage ? "is-current" : ""}`} onClick={() => setViewedStage(stage)} disabled={state?.status === "pending"} title={STAGE_LABELS[stage]} aria-current={activeStage === stage ? "step" : undefined}><span>{state?.status === "running" ? <LoaderCircle size={12} className="pv-spin" /> : index + 1}</span>{activeStage === stage && <strong>{ready && stage === "drafts" ? "営業の準備が完了" : STAGE_LABELS[stage]}</strong>}</button>; })}</div><div className="pv-future-steps"><small>これから進めること</small><span><b>7</b>メール送信</span><span><b>8</b>商談の予約</span><span><b>9</b>学習・改善</span></div></nav>
      {error && <div className="pv-notice pv-notice-error" role="alert"><span>{error}</span><button aria-label="通信エラーを閉じる" onClick={workspace.clearError}><X size={15} /></button></div>}
      {data.error && <div className="pv-notice pv-notice-error" role="alert"><span>{data.error.message}</span>{data.capabilities.canRetry && <button disabled={pending} onClick={() => void perform({ type: "retry" })}><RefreshCw size={14} />この工程を再試行</button>}</div>}
      {unsavedNotice && Object.keys(draftEdits).length > 0 && <div className="pv-notice" role="status">未保存のメールがあります。入力内容を保存してから、次へ進んでください。</div>}
      {orphanedEdits.length > 0 && <div className="pv-orphaned-edits"><p>別の画面で条件が更新されました。以前の条件で入力した文面を保持しています。</p>{orphanedEdits.map(([id, edit]) => <details key={id}><summary>{edit.subject || "未保存の下書き"}</summary><textarea readOnly value={`宛先: ${edit.to}\n件名: ${edit.subject}\n\n${edit.body}`} aria-label="以前の条件で入力した未保存メール" /><button onClick={() => setDraftEdits(current => { const next = { ...current }; delete next[id]; return next; })}>この古い下書きを破棄する</button></details>)}</div>}
      <div className="pv-stage-sections">{PREVIEW_STAGES.map((stage, index) => { const state = data.stages.find(item => item.stage === stage); const expanded = activeStage === stage; const Icon = STAGE_ICONS[stage]; return <section key={stage} className={`pv-stage-section ${expanded ? "is-open" : ""} ${expanded && mobileCollapsed ? "is-mobile-collapsed" : ""}`} aria-labelledby={`pv-stage-title-${stage}`}><button className="pv-mobile-stage-toggle" onClick={() => { if (expanded) setMobileCollapsed(value => !value); else { setViewedStage(stage); setMobileCollapsed(false); } }} aria-expanded={expanded && !mobileCollapsed} aria-controls={`pv-stage-panel-${stage}`} disabled={state?.status === "pending"}><span className={state?.status === "completed" ? "is-complete" : ""}>{state?.status === "running" ? <LoaderCircle size={13} className="pv-spin" /> : index + 1}</span><strong id={`pv-stage-title-${stage}`}>{STAGE_LABELS[stage]}</strong><ChevronDown size={16} /></button>
        {expanded && <div id={`pv-stage-panel-${stage}`} className="pv-stage-panel">
          {state?.status === "running" && <div className="pv-processing" role="status"><div className="pv-processing-icon"><Icon size={28} /></div><p className="pv-running-label"><LoaderCircle size={14} className="pv-spin" />{STAGE_LABELS[stage]}</p><h2>{STAGE_HINTS[stage]}</h2><p>このページを開いたままお待ちください。再読み込みしても続きから確認できます。</p></div>}
          {stage === "company" && data.company && <div className="pv-research-card"><div className="pv-row-between"><div><span className="pv-eyebrow">事業のリサーチ</span><h2>{data.company.name}</h2></div><button className="pv-icon-button" onClick={() => openEditor("company")} disabled={!data.capabilities.canEdit} aria-label="事業のリサーチ結果を編集"><Pencil size={17} /></button></div><p>{data.company.business}</p><dl><dt>理想のお客様</dt><dd>{data.company.customer}</dd><dt>対象の市場・地域</dt><dd>{data.company.geography}</dd></dl><SourceLinks sources={data.company.sources} /></div>}
          {stage === "competitors" && state?.status === "completed" && <div className="pv-competitor-grid">{data.competitors.length ? data.competitors.map(item => <article className="pv-research-card" key={item.website || item.name}><div className="pv-row-between"><h2>{item.name}</h2>{safeLink(item.website) && <a href={safeLink(item.website)} target="_blank" rel="noreferrer" aria-label={`${item.name}のサイトを開く`}><ExternalLink size={16} /></a>}</div><p>{item.description}</p><h3>アプローチの違い</h3><p>{item.difference}</p><SourceLinks sources={item.sources} /></article>) : <div className="pv-empty"><Search size={25} /><h2>特定できた競合はありません</h2><p>入力した事業情報を補足して、調査をやり直せます。</p><button className="pv-secondary" onClick={() => openEditor("company")}>事業情報を補足</button></div>}</div>}
          {stage === "campaigns" && state?.status === "completed" && <div className="pv-proposal-grid">{data.campaigns.map(campaign => <article className={`pv-research-card ${data.selectedCampaignId === campaign.id ? "is-selected" : ""}`} key={campaign.id}><div className="pv-row-between"><Target size={20} /><button className="pv-icon-button" onClick={() => openEditor(campaign)} disabled={!data.capabilities.canEdit} aria-label={`${campaign.name}の条件を編集`}><Pencil size={16} /></button></div><h2>{campaign.name}</h2><p>{campaign.description}</p><div className="pv-campaign-audience">{campaign.audience}</div><button className="pv-secondary" disabled={pending} onClick={() => void perform({ type: "select_campaign", campaignId: campaign.id })}>{data.selectedCampaignId === campaign.id ? <><Check size={14} />選択中</> : "このキャンペーンを選ぶ"}</button></article>)}</div>}
          {(["candidates", "verification", "drafts"] as PreviewStage[]).includes(stage) && <PreviewResults preview={data} stage={stage} pending={pending} perform={perform} onCheckout={openCheckout} edits={draftEdits} setEdits={setDraftEdits} />}
          {state?.status === "failed" && !data.error && <div className="pv-empty"><RefreshCw size={25} /><h2>この工程を完了できませんでした</h2><p>入力内容を確認し、もう一度お試しください。</p><button className="pv-secondary" disabled={pending || !data.capabilities.canRetry} onClick={() => void perform({ type: "retry" })}>再試行する</button></div>}
        </div>}
      </section>; })}</div>
      <div className="pv-mobile-cta"><button className="pv-primary" disabled={!ready} onClick={openCheckout}>{ready ? "4,500円分の無料枠で始める" : "営業の準備を進めています"}{ready ? <ArrowRight size={17} /> : <LoaderCircle size={16} className="pv-spin" />}</button></div>
    </main>
    <button className="pv-support-button" aria-label="サポートを開く" onClick={() => setSupportOpen(true)}><MessageCircle size={24} /></button>
    <Dialog.Root open={supportOpen} onOpenChange={setSupportOpen}><Dialog.Portal><Dialog.Overlay className="pv-dialog-overlay" /><Dialog.Content className="pv-small-dialog"><Dialog.Title>お手伝いします</Dialog.Title><Dialog.Description>画面の操作や顧客データの準備については、サポートをご確認ください。</Dialog.Description><Link className="pv-primary" href="/info/support">サポートを開く<ArrowRight size={15} /></Link><Dialog.Close className="pv-modal-close" aria-label="サポートを閉じる"><X size={19} /></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
    {editor && <PreviewEditModal preview={data} editor={editor} pending={pending} perform={perform} onClose={() => setEditor(null)} />}
    <CheckoutModal open={checkoutOpen} onOpenChange={setCheckoutOpen} preview={data} />
  </div>;
}

function GiftIcon() { return <span className="pv-offer-icon"><Sparkles size={24} /></span>; }
function SourceLinks({ sources }: { sources: Array<{ title: string; url: string }> }) { return sources.length > 0 && <div className="pv-source-links">{sources.filter(source => safeLink(source.url)).map((source, index) => <a href={safeLink(source.url)} key={`${source.url}-${index}`} target="_blank" rel="noreferrer"><Globe2 size={12} />{source.title || domainName(source.url)}<ExternalLink size={11} /></a>)}</div>; }
