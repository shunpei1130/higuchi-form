"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, LoaderCircle, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { PreviewAction, PreviewCampaign, PreviewSnapshot } from "@/lib/higuchi/preview/types";

export function PreviewEditModal({ preview, editor, pending, perform, onClose }: { preview: PreviewSnapshot; editor: "company" | PreviewCampaign; pending: boolean; perform: (action: PreviewAction) => Promise<boolean>; onClose: () => void }) {
  const company = editor === "company";
  const [name, setName] = useState(company ? preview.company?.name || "" : editor.name);
  const [website, setWebsite] = useState(preview.company?.website || "");
  const [description, setDescription] = useState(company ? preview.company?.business || "" : editor.description);
  const [audience, setAudience] = useState(company ? preview.company?.customer || "" : editor.audience);
  const [geography, setGeography] = useState(preview.company?.geography || "日本");
  const [instructions, setInstructions] = useState(company ? "" : editor.emailInstructions);
  const [keywords, setKeywords] = useState(company ? "" : (editor.searchTerms || []).join("、"));
  const [companySizes, setCompanySizes] = useState(company ? "" : editor.companySizes.join("、"));
  const [failed, setFailed] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setFailed(false);
    const searchTerms = keywords.split(/[,、]/).map(value => value.trim()).filter(Boolean), sizes = companySizes.split(/[,、]/).map(value => value.trim()).filter(Boolean);
    const action: PreviewAction = company ? { type: "edit_company", company: { name, website, business: description, customer: audience, geography } } : { type: "edit_campaign", campaignId: editor.id, campaign: { name, description, audience, emailInstructions: instructions, searchTerms, companySizes: sizes } };
    if (await perform(action)) onClose(); else setFailed(true);
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !pending) onClose(); }}><Dialog.Portal><Dialog.Overlay className="pv-dialog-overlay" /><Dialog.Content className="pv-edit-dialog"><Dialog.Title>{company ? "事業のリサーチを編集" : "キャンペーンを編集"}</Dialog.Title><Dialog.Description>{company ? "修正した内容を基に、関連する調査・候補・メールを準備し直します。" : "顧客像と文面の方針を保存します。関連するメールは、新しい条件に合わせて作成します。"}</Dialog.Description>
    <form className="pv-edit-form" onSubmit={submit}><label htmlFor="pv-edit-name">{company ? "会社・サービス名" : "キャンペーン名"}<input id="pv-edit-name" autoFocus required maxLength={160} value={name} onChange={event => setName(event.target.value)} disabled={pending} /></label>{company && <label htmlFor="pv-edit-website">Webサイト<input id="pv-edit-website" type="url" placeholder="https://example.com" value={website} maxLength={2000} onChange={event => setWebsite(event.target.value)} disabled={pending} /></label>}<label htmlFor="pv-edit-description">{company ? "何を提供していますか？" : "アプローチの内容"}<textarea id="pv-edit-description" rows={4} required maxLength={5000} value={description} onChange={event => setDescription(event.target.value)} disabled={pending} /></label><label htmlFor="pv-edit-audience">理想のお客様<textarea id="pv-edit-audience" rows={3} required maxLength={3000} value={audience} onChange={event => setAudience(event.target.value)} disabled={pending} /></label>{company ? <label htmlFor="pv-edit-geography">対象の市場・地域<input id="pv-edit-geography" required maxLength={300} value={geography} onChange={event => setGeography(event.target.value)} disabled={pending} /></label> : <label htmlFor="pv-edit-instructions">メール作成の方針<textarea id="pv-edit-instructions" rows={3} maxLength={3000} value={instructions} onChange={event => setInstructions(event.target.value)} disabled={pending} /></label>}{!company && <><label htmlFor="pv-edit-keywords">顧客企業の検索キーワード<input id="pv-edit-keywords" value={keywords} onChange={event => setKeywords(event.target.value)} disabled={pending} required maxLength={490} placeholder="例：イベント制作、event production" /><small>短い業種・事業名を1〜8個、読点で区切って指定します。</small></label><label htmlFor="pv-edit-company-sizes">会社規模（任意）<input id="pv-edit-company-sizes" value={companySizes} onChange={event => setCompanySizes(event.target.value)} disabled={pending} maxLength={130} placeholder="例：10-100、1000+" /><small>人数の範囲を指定します。空欄の場合は制限しません。</small></label></>}{failed && <p className="pv-error" role="alert">変更を保存できませんでした。入力を保持しています。画面のエラーを確認し、もう一度保存してください。</p>}<div className="pv-edit-actions"><button type="button" className="pv-secondary" disabled={pending} onClick={onClose}>キャンセル</button><button className="pv-primary" disabled={pending}>{pending ? <LoaderCircle size={16} className="pv-spin" /> : "変更を保存"}{!pending && <ArrowRight size={15} />}</button></div></form><Dialog.Close className="pv-modal-close" disabled={pending} aria-label="編集を閉じる"><X size={20} /></Dialog.Close>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
