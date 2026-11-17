import { ProductError } from "../state";
import { normalizeWebsite } from "../analysis";
import { parseEmployeeRanges } from "../prospectFilters";
import type { CreatePreviewInput, PatchPreviewInput, PreviewAction, PreviewState } from "./types";
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=="object"||Array.isArray(v))throw new ProductError("入力形式が正しくありません。",400,"PREVIEW_INPUT");return v as Record<string,unknown>;};
function value(v:unknown,max:number,optional=false):string {if(v===undefined&&optional)return "";if(typeof v!=="string"||v.length>max)throw new ProductError("入力内容の長さや形式を確認してください。",400,"PREVIEW_INPUT");return v.trim();}
export function previewWebsite(v:unknown):string {const url=value(v,2048,true);try{return url?normalizeWebsite(url).href:"";}catch{throw new ProductError("公開されたhttp/httpsの会社URLを入力してください。",400,"PREVIEW_INPUT");}}
export function parseCreatePreview(v:unknown):CreatePreviewInput {
  const o=object(v),website=previewWebsite(o.website),business=value(o.business,4000,true),customer=value(o.customer,2000,true),geography=value(o.geography,300,true)||"日本";
  if(!website&&!business)throw new ProductError("会社URLか事業内容を入力してください。",400,"PREVIEW_INPUT");return {website,business,customer,geography};
}
export function parsePatchPreview(v:unknown):PatchPreviewInput {
  const o=object(v);if(!Number.isSafeInteger(o.revision)||Number(o.revision)<0)throw new ProductError("画面を更新してからやり直してください。",400,"PREVIEW_REVISION");
  const a=object(o.action);let action:PreviewAction;
  switch(a.type){
    case "retry":action={type:"retry"};break;
    case "select_campaign":action={type:"select_campaign",campaignId:value(a.campaignId,100)};break;
    case "edit_draft":{
      action={type:"edit_draft",draftId:value(a.draftId,100),subject:value(a.subject,200),body:value(a.body,8000)};
      if(!action.subject||!action.body)throw new ProductError("件名と本文を入力してください。");
      if(Object.hasOwn(a,"to")){if(typeof a.to!=="string"||/[\r\n]/.test(a.to))throw new ProductError("送信先のメールアドレスを確認してください。",400,"PREVIEW_EMAIL");const to=value(a.to,254);if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to))throw new ProductError("送信先のメールアドレスを確認してください。",400,"PREVIEW_EMAIL");action.to=to;}
      break;
    }
    case "edit_company":{const c=object(a.company),company:Extract<PreviewAction,{type:"edit_company"}>["company"]={};for(const key of ["name","website","business","customer","geography"] as const)if(Object.hasOwn(c,key))company[key]=key==="website"?previewWebsite(c[key]):value(c[key],key==="business"?4000:key==="customer"?2000:300);if(!Object.keys(company).length)throw new ProductError("変更内容を入力してください。");action={type:"edit_company",company};break;}
    case "edit_campaign":{
      const c=object(a.campaign),campaign:Extract<PreviewAction,{type:"edit_campaign"}>["campaign"]={};
      for(const key of ["name","description","audience","emailInstructions"] as const)if(Object.hasOwn(c,key))campaign[key]=value(c[key],key==="name"?200:2000);
      if(Object.hasOwn(c,"searchTerms")){if(!Array.isArray(c.searchTerms)||c.searchTerms.length<1||c.searchTerms.length>8)throw new ProductError("検索キーワードは1〜8個で指定してください。");campaign.searchTerms=[...new Set(c.searchTerms.map(term=>{const text=value(term,60);if(text.length<2||/[\u0000-\u001f]/.test(text))throw new ProductError("検索キーワードは2〜60文字で指定してください。");return text;}))];}
      if(Object.hasOwn(c,"companySizes")){if(!Array.isArray(c.companySizes)||c.companySizes.length>5)throw new ProductError("会社規模は5個以内で指定してください。");const sizes=c.companySizes.map(size=>value(size,30));if(sizes.some(size=>! /^[0-9]+(?:-[0-9]+|\+)?$/.test(size)))throw new ProductError("会社規模は「10-100」「100+」のように人数で指定してください。");parseEmployeeRanges(sizes);campaign.companySizes=[...new Set(sizes)];}
      if(!Object.keys(campaign).length)throw new ProductError("変更内容を入力してください。");
      action={type:"edit_campaign",campaignId:value(a.campaignId,100),campaign};break;
    }
    default:throw new ProductError("この操作は利用できません。",400,"PREVIEW_ACTION");
  }
  return {revision:Number(o.revision),action};
}
export function applyPreviewEdit(state:PreviewState,action:Exclude<PreviewAction,{type:"retry"}>):{restart:boolean} {
  if(action.type==="edit_company") {if(!state.company)throw new ProductError("会社調査の完了をお待ちください。",409,"PREVIEW_NOT_READY");Object.assign(state.company,action.company);return {restart:true};}
  if(action.type==="select_campaign") {if(!state.campaigns.some(c=>c.id===action.campaignId))throw new ProductError("キャンペーンが見つかりません。",404);state.selectedCampaignId=action.campaignId;return {restart:false};}
  if(action.type==="edit_campaign"){const c=state.campaigns.find(c=>c.id===action.campaignId);if(!c)throw new ProductError("キャンペーンが見つかりません。",404);Object.assign(c,action.campaign);return {restart:false};}
  const draft=state.drafts.find(d=>d.id===action.draftId);if(!draft)throw new ProductError("文面が見つかりません。",404);
  if(action.to!==undefined){const candidate=state.candidates.find(c=>c.id===draft.candidateId);if(!candidate)throw new ProductError("候補が見つかりません。",404);if(candidate.email!==action.to){if(state.candidates.some(c=>c.id!==candidate.id&&c.campaignId===candidate.campaignId&&c.email.toLowerCase()===action.to!.toLowerCase()))throw new ProductError("同じキャンペーンに、このメールアドレスの候補がすでにあります。",409,"PREVIEW_DUPLICATE_RECIPIENT");candidate.email=action.to;candidate.verification=candidate.sample?"sample":"unknown";candidate.reason=candidate.sample?"架空の確認用データです。実際の送信はできません。":"利用者が送信先を変更しました。このアドレスの配信可否は未検証です。";}}
  draft.subject=action.subject;draft.body=action.body;draft.revision++;return {restart:false};
}
export function assertPreviewRevision(actual:number,expected:number):void {if(actual!==expected)throw new ProductError("調査が更新されました。最新の内容を読み込んでください。",409,"PREVIEW_REVISION_CONFLICT");}
