import { createHash } from "node:crypto";
import { activateJpyBilling, ProductError, recordActivity, type WorkspaceState } from "./state";
import { billingPolicy } from "./money";
import { usablePreviewCandidate, type PreviewCandidate, type PreviewState } from "./preview/types";

export function previewEntityId(kind:string,runId:string,organizationId:string,sourceId=""):string{
  const hex=createHash("sha256").update([kind,runId,organizationId,sourceId].join(":" )).digest("hex").slice(0,32).split("");hex[12]="4";hex[16]="8";const s=hex.join("");return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
export function usablePreviewContact(candidate:PreviewCandidate):boolean {
  return usablePreviewCandidate(candidate);
}
export type ClaimedPreview={projectId:string;campaignIds:string[];sample:false;redirectUrl:string};
export function selectedPreviewDrafts(preview:PreviewState){const selected=preview.selectedCampaignId??preview.campaigns[0]?.id,seen=new Set<string>();return preview.drafts.filter(draft=>{const candidate=preview.candidates.find(item=>item.id===draft.candidateId&&item.campaignId===selected);if(draft.sample||!draft.subject.trim()||!draft.body.trim()||draft.subject.length>200||draft.body.length>8000||draft.campaignId!==selected||!candidate||!usablePreviewContact(candidate)||seen.has(candidate.email.toLowerCase()))return false;seen.add(candidate.email.toLowerCase());return true;});}
export function previewApprovalHash(state:PreviewState):string{return createHash("sha256").update(JSON.stringify({terms:"jpy-2026-11-v1",drafts:selectedPreviewDrafts(state).map(draft=>({id:draft.id,to:state.candidates.find(c=>c.id===draft.candidateId)?.email,subject:draft.subject,body:draft.body,revision:draft.revision}))})).digest("hex");}
export function previewConsentKey(run:{id:string;state:PreviewState},sessionId:string):string{return `preview-consent:${run.id}:${sessionId}:${previewApprovalHash(run.state)}`;}
/** Only an exact signed receipt can release a worker lease left during confirmation. */
export function releaseVerifiedPreviewLease(state:WorkspaceState,runId:string,sessionId:string):boolean{
  const pending=state.billing.pendingPreviewSessions?.[runId],verified=state.billing.verifiedPreviewSessions?.[runId];
  if(!pending?.lockId||pending.sessionId!==sessionId||!verified||verified.sessionId!==sessionId||pending.mode!==verified.mode||pending.amountMinor!==verified.amountMinor||pending.currency!==verified.currency)return false;
  delete pending.lockId;delete pending.leaseUntil;return true;
}
/** Pure import: approved text is copied once; no outbox, billing job or review timer is created. */
export function applyPreviewClaim(state:WorkspaceState,preview:PreviewState,runId:string,organizationId:string):ClaimedPreview {
  if(preview.sample||!preview.company)throw new ProductError("サンプルでは送信・決済を開始できません。実データの接続後にご利用ください。",409,"SAMPLE_PREVIEW");
  const validDrafts=selectedPreviewDrafts(preview);
  if(!validDrafts.length)throw new ProductError("送信先とメール案を確認してください。",409,"PREVIEW_NO_CONTACTS");
  activateJpyBilling(state);const policy=billingPolicy("JPY"),projectId=previewEntityId("project",runId,organizationId);
  const campaignIds=preview.campaigns.map(campaign=>previewEntityId("campaign",runId,organizationId,campaign.id));
  const result={projectId,campaignIds,sample:false as const,redirectUrl:`/app/campaigns/${previewEntityId("campaign",runId,organizationId,preview.selectedCampaignId??preview.campaigns[0]?.id??"")}`};
  if(state.projects.some(project=>project.id===projectId))return result;
  const company=preview.company;
  state.projects.push({id:projectId,previewRunId:runId,name:company.name,website:company.website,description:company.business,icp:company.customer,createdAt:state.now,status:"ready",analysisSources:company.sources.map(source=>source.url),dailyBudgetCents:policy.defaultDailyMinor,monthlyBudgetCents:policy.defaultMonthlyMinor,autopilot:false,geography:company.geography,segments:preview.campaigns.map(c=>({name:c.name,valueProposition:c.valueProposition,painPoints:c.painPoints,roles:c.roles,locations:c.locations,companySizes:c.companySizes,includeCriteria:c.includeCriteria,excludeCriteria:c.excludeCriteria,emailInstructions:c.emailInstructions}))});
  for(const campaign of preview.campaigns){const campaignId=previewEntityId("campaign",runId,organizationId,campaign.id),first=validDrafts.find(d=>d.campaignId===campaign.id);
    state.campaigns.push({id:campaignId,projectId,name:campaign.name,audience:campaign.audience,objective:campaign.description,status:"draft",dailyBudgetCents:Math.max(policy.emailMinor,Math.floor(policy.defaultDailyMinor/Math.max(1,preview.campaigns.length))),emailSubject:first?.subject??"{{company}}様へのご提案",emailBody:first?.body??"{{name}}様\n\n事業についてご案内します。",followUpDays:[3,7],autoReply:false,sentCount:0,replyCount:0,meetingCount:0,createdAt:state.now,reviewEndsAt:null,reviewRemainingMs:null,upstreamCampaignId:null,language:"ja",sendWeekdays:[1,2,3,4,5],replyDelayMinutes:15,targeting:{valueProposition:campaign.valueProposition,painPoints:campaign.painPoints,roles:campaign.roles,locations:campaign.locations,companySizes:campaign.companySizes,includeCriteria:campaign.includeCriteria,excludeCriteria:campaign.excludeCriteria,emailInstructions:campaign.emailInstructions}});
  }
  for(const draft of validDrafts){const candidate=preview.candidates.find(c=>c.id===draft.candidateId)!;
    if(state.leads.some(lead=>lead.projectId===projectId&&lead.email===candidate.email.toLowerCase()))continue;
    state.leads.push({id:previewEntityId("lead",runId,organizationId,candidate.id),projectId,campaignId:previewEntityId("campaign",runId,organizationId,draft.campaignId),name:candidate.name,email:candidate.email.toLowerCase(),company:candidate.company,role:candidate.role,website:candidate.website,status:"ready",source:"dataset",lastContactAt:null,nextFollowUpAt:null,followUpStep:0,preparedEmail:{subject:draft.subject.replace(/[\r\n]/g," ").slice(0,200),body:draft.body,revision:draft.revision}});
  }
  state.activeProjectId=projectId;recordActivity(state,"調査結果と確認済みメール案を取り込みました。開始の確認までは送信しません。","info",projectId);return result;
}

/** Compares the approved immutable preview to the recipient and exact persisted body before starting. */
export function assertApprovedPreviewLeads(state:WorkspaceState,preview:PreviewState,runId:string,organizationId:string,projectId:string):void {
  const drafts=selectedPreviewDrafts(preview);
  if(!drafts.length)throw new ProductError("確認済みの送信先がありません。",409,"PREVIEW_NO_CONTACTS");
  for(const draft of drafts){
    const candidate=preview.candidates.find(c=>c.id===draft.candidateId)!;
    const campaignId=previewEntityId("campaign",runId,organizationId,draft.campaignId);
    const lead=state.leads.find(l=>l.id===previewEntityId("lead",runId,organizationId,candidate.id)&&l.projectId===projectId&&l.campaignId===campaignId);
    if(!lead?.preparedEmail||lead.email.toLowerCase()!==candidate.email.toLowerCase()||lead.preparedEmail.subject!==draft.subject.replace(/[\r\n]/g," ").slice(0,200)||lead.preparedEmail.body!==draft.body||lead.preparedEmail.revision!==draft.revision)throw new ProductError("宛先またはメール案が変更されています。キャンペーン画面で再確認してください。",409,"DRAFT_CHANGED");
  }
}
