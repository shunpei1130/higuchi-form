import { afterEach, expect, test } from "bun:test";
import { PREVIEW_STAGES, emptyPreviewState, usablePreviewCandidate, type PreviewCampaign, type PreviewCandidate } from "./types";
import { parseCreatePreview, parsePatchPreview, applyPreviewEdit, assertPreviewRevision } from "./rules";
import { previewAiReservation, previewAiActual, assertPreviewBudget } from "./budget";
import { catalogCandidates, executePreviewStage, sampleCandidates, type ResearchDependencies } from "./research";
import { previewSnapshot, previewCookie, readPreviewToken, previewTokenHash, type PreviewRun } from "./store";
import { assertPreviewDispatcher, previewDispatchUrl } from "./dispatch";
const env={CRON_SECRET:process.env.CRON_SECRET,BETTER_AUTH_URL:process.env.BETTER_AUTH_URL};afterEach(()=>{for(const [k,v] of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;});
const campaign:PreviewCampaign={id:"campaign-a",name:"製造業",description:"製造業向け",audience:"製造企業",valueProposition:"効率化",painPoints:"手作業",roles:["代表"],locations:["日本"],companySizes:["30-100"],searchTerms:["製造業","manufacturing"],includeCriteria:"製造業",excludeCriteria:"配信停止",emailInstructions:"短く",estimatedLeads:null};
function run():PreviewRun {return {id:"00000000-0000-4000-8000-000000000001",sessionId:"00000000-0000-4000-8000-000000000002",input:{website:"https://seller.example/",business:"業務改善",customer:"製造業",geography:"日本"},state:emptyPreviewState(),status:"running",revision:1,generation:0,stageIndex:0,attempts:1,retryCount:0,lockedBy:"worker",leaseUntil:new Date(Date.now()+90000),runAfter:new Date(),errorCode:null,errorMessage:null,errorRetryable:0,claimedOrganizationId:null,claimedProjectId:null,claimedAt:null,expiresAt:new Date(Date.now()+86400000),createdAt:new Date(),updatedAt:new Date()};}
test("bounded inputs reject unsafe URLs, excessive bodies and missing company context",()=>{
  expect(parseCreatePreview({website:"seller.example",geography:"米国"}).geography).toBe("米国");
  expect(parseCreatePreview({business:"事業説明"}).website).toBe("");
  expect(()=>parseCreatePreview({})).toThrow();expect(()=>parseCreatePreview({website:"file:///etc/passwd"})).toThrow();expect(()=>parseCreatePreview({website:"https://user:secret@seller.example"})).toThrow();expect(()=>parseCreatePreview({business:"あ".repeat(4001)})).toThrow();
});
test("revision and allowlisted edits do not copy prototype or privileged fields",()=>{
  expect(()=>assertPreviewRevision(3,2)).toThrow();const state=emptyPreviewState();state.company={name:"A",website:"",business:"業務改善",customer:"企業",geography:"日本",summary:"",sources:[]};
  const parsed=parsePatchPreview(JSON.parse('{"revision":1,"action":{"type":"edit_company","company":{"business":"修正","__proto__":{"polluted":true},"sample":false}}}'));
  if(parsed.action.type!=="retry")applyPreviewEdit(state,parsed.action);expect(state.company.business).toBe("修正");expect(state.sample).toBe(true);expect(({} as Record<string,unknown>).polluted).toBeUndefined();
});
test("draft edits preserve stable identities and increment draft revision",()=>{
  const state=emptyPreviewState();state.drafts=[{id:"draft-a",candidateId:"person-a",campaignId:"campaign-a",subject:"before",body:"before",revision:2,sample:true}];
  applyPreviewEdit(state,{type:"edit_draft",draftId:"draft-a",subject:"編集後",body:"編集本文"});expect(state.drafts[0]).toMatchObject({id:"draft-a",revision:3,sample:true,body:"編集本文"});
});
test("recipient edits never promote a fictional sample to a real lead",()=>{
  const r=run();Object.assign(r.state,sampleCandidates([campaign]));const person=r.state.candidates[0];r.state.drafts=[{id:"d",candidateId:person.id,campaignId:person.campaignId,subject:"件名",body:"本文",revision:0,sample:true}];
  applyPreviewEdit(r.state,{type:"edit_draft",draftId:"d",subject:"件名",body:"本文",to:"human@real-company.jp"});r.status="ready";
  expect(person.email).toBe("human@real-company.jp");expect(person.sample).toBe(true);expect(person.verification).toBe("sample");expect(r.state.drafts[0].sample).toBe(true);expect(previewSnapshot(r).capabilities.canCheckout).toBe(false);
});
test("a changed real recipient is unverified and only the selected run's candidate changes",()=>{
  const r=run();r.state.candidates=[{id:"p",campaignId:"c",name:"担当",email:"before@company.jp",company:"会社",role:"代表",website:"",sample:false,verification:"verified",source:"dataset",reason:"検証済み"}];r.state.drafts=[{id:"d",candidateId:"p",campaignId:"c",subject:"件名",body:"本文",revision:0,sample:false}];const other=structuredClone(r.state);
  applyPreviewEdit(r.state,{type:"edit_draft",draftId:"d",subject:"変更",body:"本文",to:"after@company.jp"});expect(r.state.candidates[0]).toMatchObject({email:"after@company.jp",verification:"unknown",sample:false});expect(r.state.drafts[0].revision).toBe(1);expect(other.candidates[0].email).toBe("before@company.jp");
});
test("recipient input rejects malformed addresses, CRLF and more than 254 characters",()=>{
  for(const to of ["missing-at.example.jp","x@company.jp\r\nBcc: other@company.jp","x@company.jp\n",`${"a".repeat(250)}@company.jp`])expect(()=>parsePatchPreview({revision:0,action:{type:"edit_draft",draftId:"d",subject:"件名",body:"本文",to}})).toThrow();
});
test("recipient edits reject case-insensitive duplicates in the same campaign",()=>{
  const state=emptyPreviewState();Object.assign(state,sampleCandidates([campaign]));const [one,two]=state.candidates;state.drafts=[{id:"d",candidateId:one.id,campaignId:one.campaignId,subject:"件名",body:"本文",revision:0,sample:true}];
  expect(()=>applyPreviewEdit(state,{type:"edit_draft",draftId:"d",subject:"件名",body:"本文",to:two.email.toUpperCase()})).toThrow("すでにあります");expect(state.candidates[0].email).toBe(one.email);expect(state.drafts[0].revision).toBe(0);
});
test("sample candidates are explicitly fictional and cannot unlock claim or checkout",()=>{
  const r=run();Object.assign(r.state,sampleCandidates([campaign]));r.status="ready";r.stageIndex=6;r.state.drafts=[{id:"d",candidateId:r.state.candidates[0].id,campaignId:campaign.id,subject:"件名",body:"本文",sample:true,revision:0}];
  expect(r.state.candidates.every(c=>c.sample&&c.email.endsWith(".example")&&c.verification==="sample")).toBe(true);expect(previewSnapshot(r).capabilities).toMatchObject({canClaim:false,canCheckout:false,canActivate:false});
});
test("published empty data never silently falls back to fictional people",()=>{
  expect(catalogCandidates({available:true,datasetRevision:"v1",companies:[],people:[]},[campaign])).toMatchObject({sample:false,candidates:[],companies:[]});
  expect(catalogCandidates({available:false,datasetRevision:"",companies:[],people:[]},[campaign]).sample).toBe(true);
});
test("company-only dataset metadata and imported uncertain verification survive mapping",()=>{
  const base={available:true,datasetRevision:"v1",companies:[{id:"c",name:"実会社",domain:"business.example",description:"説明",location:"東京",employeeCount:42,monthlyTraffic:300,trafficGrowth:2,sourceUrl:""}],people:[]};
  expect(catalogCandidates(base,[campaign]).companies[0]).toMatchObject({employeeCount:42,monthlyTraffic:300,trafficGrowth:2});
  const mapped=catalogCandidates({...base,people:[{id:"p",companyId:"c",name:"担当",role:"代表",email:"x@business.example",verification:"catch_all" as const,location:"東京",sourceUrl:"",sourceLabel:"Excel"}]},[campaign]);expect(mapped.candidates[0]).toMatchObject({verification:"catch_all",sample:false,sourceLabel:"Excel"});
});
test("ready live data without a usable draft never permits payment",()=>{const r=run();r.status="ready";r.state.sample=false;expect(previewSnapshot(r).capabilities.canCheckout).toBe(false);});
test("a contact in another campaign cannot unlock checkout for an empty selected campaign",()=>{
  const r=run();r.status="ready";r.state.sample=false;r.state.selectedCampaignId="selected-empty";r.state.campaigns=[{...campaign,id:"selected-empty"},campaign];r.state.candidates=[{id:"p",campaignId:campaign.id,name:"担当",email:"contact@real-company.jp",company:"企業",role:"代表",website:"",sample:false,verification:"unknown",source:"dataset",reason:"未検証"}];r.state.drafts=[{id:"d",candidateId:"p",campaignId:campaign.id,subject:"件名",body:"本文",revision:0,sample:false}];
  expect(previewSnapshot(r).capabilities.canClaim).toBe(false);expect(previewSnapshot(r).capabilities.canCheckout).toBe(false);r.state.selectedCampaignId=campaign.id;expect(previewSnapshot(r).capabilities.canCheckout).toBe(true);
});
test("published datasets cannot duplicate the same case-insensitive mailbox",()=>{
  const result=catalogCandidates({available:true,datasetRevision:"v",companies:[{id:"c",name:"企業",domain:"real-company.jp",description:"会社説明",location:"日本",employeeCount:null,monthlyTraffic:null,trafficGrowth:null,sourceUrl:""}],people:["one","two"].map((id,i)=>({id,companyId:"c",name:"担当",role:"代表",email:i?"CONTACT@real-company.jp":"contact@real-company.jp",verification:"unknown" as const,location:"日本",sourceUrl:"",sourceLabel:"CSV"}))},[campaign]);expect(result.candidates).toHaveLength(1);
});
test("unknown and catch-all retain honest labels and permit drafts; invalid and pending stay excluded",async()=>{
  const r=run();r.stageIndex=5;r.state.sample=false;r.state.campaigns=[campaign];r.state.selectedCampaignId=campaign.id;
  r.state.candidates=["unknown","catch_all","invalid","pending"].map((verification,i)=>({id:`person-${i}`,campaignId:campaign.id,name:"担当者",email:`contact${i}@real-company.jp`,company:"企業",role:"代表",website:"https://real-company.jp",sample:false,verification:verification as PreviewCandidate["verification"],source:"dataset",reason:"提供元の判定"}));
  expect(r.state.candidates.map(usablePreviewCandidate)).toEqual([true,true,false,false]);
  const state=await executePreviewStage(r,{ai:async input=>{const context=JSON.parse(input.user);expect(context.candidates.map((c:PreviewCandidate)=>c.verification)).toEqual(["unknown","catch_all"]);return {text:JSON.stringify({drafts:context.candidates.map((c:PreviewCandidate)=>({candidateId:c.id,subject:"件名",body:"本文"}))}),sources:[]};}});
  r.state=state;r.status="ready";expect(state.drafts).toHaveLength(2);expect(previewSnapshot(r).capabilities.canCheckout).toBe(true);expect(state.candidates[0].verification).toBe("unknown");expect(state.candidates[1].verification).toBe("catch_all");
});
test("search reservations include tool fees and returned context and fail closed at either budget",()=>{
  const reservation=previewAiReservation({system:"system",user:"user",maxOutputTokens:2600,maxSearchCalls:3});expect(reservation).toBeGreaterThan(60000);expect(reservation).toBeLessThan(100000);expect(previewAiActual(100,200,3)).toBe(30110);expect(()=>assertPreviewBudget(100000,0,reservation,20000000)).toThrow();expect(()=>assertPreviewBudget(0,20000000,reservation,20000000)).toThrow();
});
test("dispatcher requires exact secret and a server-owned secure origin",()=>{
  process.env.CRON_SECRET="a".repeat(32);process.env.BETTER_AUTH_URL="https://form-higuchi.example/";expect(()=>assertPreviewDispatcher(new Request("https://form-higuchi.example/api/previews/dispatch"))).toThrow();assertPreviewDispatcher(new Request("https://form-higuchi.example/api/previews/dispatch",{headers:{Authorization:`Bearer ${process.env.CRON_SECRET}`}}));expect(previewDispatchUrl()).toBe("https://form-higuchi.example/api/previews/dispatch");process.env.BETTER_AUTH_URL="http://localhost:3000";expect(()=>previewDispatchUrl()).toThrow();
});
test("public DTO omits ownership hashes, leases and request secrets",()=>{const snapshot=previewSnapshot(run());expect(Object.keys(snapshot)).not.toContain("sessionId");expect(Object.keys(snapshot)).not.toContain("lockedBy");const token="a".repeat(43);expect(readPreviewToken(new Request("https://example.test",{headers:{Cookie:`higuchi_preview=${token}`}}))).toBe(token);expect(previewCookie(token)).toContain("HttpOnly");expect(previewTokenHash(token)).not.toBe(token);});
test("six real stages use supplied provider seams and keep unsupported competitor claims out",async()=>{
  const r=run();const ai:ResearchDependencies["ai"]=async input=>{
    const values:Record<string,unknown>={company:{name:"提供会社",business:"業務改善",customer:"製造業",geography:"日本",summary:"事業説明"},competitors:{competitors:[{name:"根拠あり",website:"https://competitor.example/",description:"競合説明",difference:"違い",sourceUrls:["https://competitor.example/"]},{name:"創作",website:"https://invented.example/",description:"",difference:"",sourceUrls:["https://invented.example/"]}]},campaigns:{campaigns:[0,1,2].map(i=>({...campaign,id:`campaign-${i}`,name:`製造業${i}`}))},drafts:{drafts:r.state.candidates.map(c=>({candidateId:c.id,subject:"情報交換のご相談",body:"確認用の提案です。"}))}};
    return {text:JSON.stringify(values[input.stage]),sources:[{url:"https://competitor.example/",title:"競合の公式"}]};
  };
  for(let i=0;i<PREVIEW_STAGES.length;i++){r.stageIndex=i;r.state=await executePreviewStage(r,{ai,page:async()=>({url:"https://seller.example/",text:"公開された業務改善の会社説明"}),catalog:async()=>({available:false,datasetRevision:"",companies:[],people:[]})});}
  expect(r.state.company?.geography).toBe("日本");expect(r.state.competitors).toHaveLength(1);expect(r.state.campaigns).toHaveLength(3);expect(r.state.drafts).toHaveLength(9);expect(r.state.sample).toBe(true);expect(r.state.candidates.every(c=>c.verification==="sample")).toBe(true);
});
