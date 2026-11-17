import { expect, test } from "bun:test";
import { createWorkspace } from "./state";
import { emptyPreviewState } from "./preview/types";
import { applyPreviewClaim, assertApprovedPreviewLeads, previewApprovalHash, previewConsentKey, previewEntityId, releaseVerifiedPreviewLease, selectedPreviewDrafts } from "./previewClaimContract";
import { parsePatchPreview } from "./preview/rules";

const runId="00000000-0000-4000-8000-000000000001",org="00000000-0000-4000-8000-00000000000a";
function preview(){
  const state=emptyPreviewState();state.sample=false;state.company={name:"会社",website:"https://seller.jp",business:"業務改善",customer:"企業",geography:"日本",summary:"会社説明",sources:[]};
  const campaign={id:"campaign-a",name:"経営者",description:"説明",audience:"経営者",valueProposition:"改善",painPoints:"手作業",roles:["代表"],locations:["日本"],companySizes:[],includeCriteria:"企業",excludeCriteria:"配信停止",emailInstructions:"短く",estimatedLeads:1,searchTerms:[] as string[]};
  state.campaigns=[campaign,{...campaign,id:"campaign-b"}];state.selectedCampaignId=campaign.id;
  state.candidates=[{id:"person-a",campaignId:campaign.id,name:"担当者",email:"contact@real-company.jp",company:"企業",role:"代表",website:"",sample:false,verification:"unknown",source:"dataset",reason:"提供データ"}];
  state.drafts=[{id:"draft-a",candidateId:"person-a",campaignId:campaign.id,subject:"情報交換のご相談",body:"ご相談本文",revision:2,sample:false}];return state;
}
test("claims copy the entire approved 8,000-character body with no outbox, credit or automatic activation",()=>{
  const p=preview(),state=createWorkspace("live","2026-11-17T00:00:00Z","JPY");p.drafts[0].body="本文".repeat(4000);
  const result=applyPreviewClaim(state,p,runId,org);expect(state.leads[0].preparedEmail?.body).toBe(p.drafts[0].body);expect(state.leads[0].preparedEmail?.body).toHaveLength(8000);expect(state.campaigns.every(c=>c.status==="draft"&&!c.autoReply)).toBe(true);expect(state.internal.outbox).toHaveLength(0);expect(state.internal.billingJobs).toHaveLength(0);expect(state.ledger).toHaveLength(0);expect(state.billing.balanceCents).toBe(0);assertApprovedPreviewLeads(state,p,runId,org,result.projectId);
});
test("samples, empty content and an empty selected campaign never claim or prepare contacts",()=>{
  const p=preview();p.sample=true;expect(()=>applyPreviewClaim(createWorkspace("live",undefined,"JPY"),p,runId,org)).toThrow("サンプル");p.sample=false;p.drafts[0].sample=true;expect(selectedPreviewDrafts(p)).toHaveLength(0);p.drafts[0].sample=false;p.drafts[0].body=" \n ";expect(selectedPreviewDrafts(p)).toHaveLength(0);p.drafts[0].body="本文";p.selectedCampaignId="campaign-b";expect(selectedPreviewDrafts(p)).toHaveLength(0);expect(()=>applyPreviewClaim(createWorkspace("live",undefined,"JPY"),p,runId,org)).toThrow("送信先");
});
test("selected campaign duplicates use the first valid mailbox, never contacts in another campaign",()=>{
  const p=preview();p.candidates.push({...p.candidates[0],id:"duplicate",email:"CONTACT@real-company.jp"},{...p.candidates[0],id:"other-campaign",campaignId:"campaign-b"});p.drafts.push({...p.drafts[0],id:"duplicate-draft",candidateId:"duplicate"},{...p.drafts[0],id:"other-draft",candidateId:"other-campaign",campaignId:"campaign-b"});
  expect(selectedPreviewDrafts(p).map(d=>d.id)).toEqual(["draft-a"]);const state=createWorkspace("live",undefined,"JPY");applyPreviewClaim(state,p,runId,org);expect(state.leads).toHaveLength(1);expect(state.leads[0].email).toBe("contact@real-company.jp");
});
test("repeated claims are idempotent and generated identities cannot cross organizations",()=>{
  const p=preview(),state=createWorkspace("live",undefined,"JPY"),first=applyPreviewClaim(state,p,runId,org),second=applyPreviewClaim(state,p,runId,org);expect(second).toEqual(first);expect(state.projects).toHaveLength(1);expect(state.leads).toHaveLength(1);expect(previewEntityId("project",runId,org)).not.toBe(previewEntityId("project",runId,"00000000-0000-4000-8000-00000000000b"));
});
test("stale body, recipient, revision or campaign affiliation cannot pass the start fence",()=>{
  const p=preview(),original=createWorkspace("live",undefined,"JPY"),result=applyPreviewClaim(original,p,runId,org);
  for(const change of ["body","email","revision","campaign"]){const state=structuredClone(original);if(change==="body")state.leads[0].preparedEmail!.body="古い本文";if(change==="email")state.leads[0].email="other@real-company.jp";if(change==="revision")state.leads[0].preparedEmail!.revision--;if(change==="campaign")state.leads[0].campaignId="other-campaign";expect(()=>assertApprovedPreviewLeads(state,p,runId,org,result.projectId)).toThrow("変更されています");}
});
test("approval receipts bind exact revision, recipient, text and Checkout session",()=>{
  const p=preview(),run={id:runId,state:p},before=previewApprovalHash(p),key=previewConsentKey(run,"cs_one");expect(previewConsentKey(run,"cs_one")).toBe(key);expect(previewConsentKey(run,"cs_two")).not.toBe(key);
  for(const field of ["body","email","revision"]){const state=structuredClone(p);if(field==="body")state.drafts[0].body+="変更";if(field==="email")state.candidates[0].email="new@real-company.jp";if(field==="revision")state.drafts[0].revision++;expect(previewApprovalHash(state)).not.toBe(before);}
});
test("recipient validation rejects angle brackets before saving a draft",()=>{
  for(const to of ["a<@company.jp","a>@company.jp","Name <a@company.jp>"])expect(()=>parsePatchPreview({revision:1,action:{type:"edit_draft",draftId:"d",subject:"件名",body:"本文",to}})).toThrow();
});

test("only an identical signed checkout receipt releases a confirmation-time lease",()=>{
 const state=createWorkspace("live",undefined,"JPY");state.billing.pendingPreviewSessions={run:{sessionId:"cs_test_one",mode:"payment",amountMinor:4500,currency:"JPY",lockId:"worker",leaseUntil:"2026-11-18T00:00:00Z"}};
 expect(releaseVerifiedPreviewLease(state,"run","cs_test_one")).toBe(false);
 state.billing.verifiedPreviewSessions={run:{sessionId:"cs_test_two",mode:"payment",amountMinor:4500,currency:"JPY",verifiedAt:"2026-11-17T00:00:00Z"}};
 expect(releaseVerifiedPreviewLease(state,"run","cs_test_one")).toBe(false);
 state.billing.verifiedPreviewSessions.run.sessionId="cs_test_one";state.billing.verifiedPreviewSessions.run.amountMinor=7500;
 expect(releaseVerifiedPreviewLease(state,"run","cs_test_one")).toBe(false);
 state.billing.verifiedPreviewSessions.run.amountMinor=4500;
 expect(releaseVerifiedPreviewLease(state,"run","cs_test_two")).toBe(false);
 expect(releaseVerifiedPreviewLease(state,"run","cs_test_one")).toBe(true);
 expect(state.billing.pendingPreviewSessions.run.lockId).toBeUndefined();expect(state.billing.pendingPreviewSessions.run.leaseUntil).toBeUndefined();
});
