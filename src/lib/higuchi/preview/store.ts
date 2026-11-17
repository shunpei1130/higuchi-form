import "server-only";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ProductError } from "../state";
import { higuchiPreviewDailyLimits, higuchiPreviewRuns, higuchiPreviewSessions, higuchiPreviewWorkerSlots } from "./schema";
import { PREVIEW_STAGES, emptyPreviewState, usablePreviewCandidate, type CreatePreviewInput, type PatchPreviewInput, type PreviewSnapshot, type PreviewState } from "./types";
import { applyPreviewEdit, assertPreviewRevision } from "./rules";
import { markPreviewFixtureState, previewFixtureLocalHttp } from "./fixture";

export type PreviewTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type PreviewRun = typeof higuchiPreviewRuns.$inferSelect;
export const PREVIEW_COOKIE="higuchi_preview";
const TTL=24*60*60*1000;
const LEASE_MS=90000;
export const previewTokenHash=(token:string)=>createHash("sha256").update(token).digest("hex");
export function readPreviewToken(request:Request):string|null {
  const token=request.headers.get("cookie")?.split(";").map(p=>p.trim()).find(p=>p.startsWith(`${PREVIEW_COOKIE}=`))?.slice(PREVIEW_COOKIE.length+1);
  return token&&/^[A-Za-z0-9_-]{43}$/.test(token)?token:null;
}
export function previewCookie(token:string):string {return `${PREVIEW_COOKIE}=${token}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax${(process.env.NODE_ENV==="production"||process.env.VERCEL)&&!previewFixtureLocalHttp()?"; Secure":""}`;}
export function previewIpDayHash(request:Request,day:string):string {
  const secret=process.env.BETTER_AUTH_SECRET;if(!secret)throw new ProductError("匿名調査の認証設定が必要です。",503,"PREVIEW_UNCONFIGURED");
  // Vercel overwrites this header. Arbitrary X-Forwarded-For is never trusted.
  const ip=process.env.VERCEL?request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim()||"unknown":"local";
  return createHmac("sha256",secret).update(`preview:${day}:${ip}`).digest("hex");
}
function assertId(id:string):void {if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw new ProductError("調査が見つかりません。",404,"PREVIEW_NOT_FOUND");}
export function previewSnapshot(row:PreviewRun):PreviewSnapshot {
  const editable=row.status!=="claimed",ready=row.status==="ready",selected=row.state.selectedCampaignId??row.state.campaigns[0]?.id,usable=ready&&!row.state.sample&&row.state.drafts.some(d=>d.campaignId===selected&&!d.sample&&row.state.candidates.some(c=>c.id===d.candidateId&&c.campaignId===selected&&usablePreviewCandidate(c)&&d.subject&&d.body));
  return {...row.state,id:row.id,status:row.status,revision:row.revision,currentStage:PREVIEW_STAGES[row.stageIndex]??null,createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString(),expiresAt:row.expiresAt.toISOString(),error:row.errorCode?{code:row.errorCode,message:row.errorMessage??"調査を再開できませんでした。",retryable:row.errorRetryable===1}:null,...(row.claimedProjectId?{claimedProjectId:row.claimedProjectId}:{}),capabilities:{canEdit:editable,canRetry:row.status==="failed"&&row.errorRetryable===1&&row.retryCount<2,canClaim:Boolean(usable),canActivate:false,canCheckout:Boolean(usable)}};
}
export async function createPreview(request:Request,input:CreatePreviewInput):Promise<{snapshot:PreviewSnapshot;cookie:string|null}> {
  const now=new Date(),day=now.toISOString().slice(0,10),ipHash=previewIpDayHash(request,day),existingToken=readPreviewToken(request),token=existingToken??randomBytes(32).toString("base64url"),hash=previewTokenHash(token);
  return db.transaction(async tx=>{
    // Serializes newly minted sessions too, so rotating cookies never evades the IP/day cap.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`preview-ip:${ipHash}`},0))`);
    let [session]=await tx.select().from(higuchiPreviewSessions).where(and(eq(higuchiPreviewSessions.tokenHash,hash),gt(higuchiPreviewSessions.expiresAt,now))).for("update");
    if(session){const [active]=await tx.select().from(higuchiPreviewRuns).where(and(eq(higuchiPreviewRuns.sessionId,session.id),gt(higuchiPreviewRuns.expiresAt,now))).orderBy(sql`${higuchiPreviewRuns.createdAt} desc`).limit(1);if(active&&["queued","running","ready"].includes(active.status)){const same=JSON.stringify(active.input)===JSON.stringify(input);if(same)return {snapshot:previewSnapshot(active),cookie:null};if(active.status!=="ready")throw new ProductError("実行中の調査が完了してから、新しい調査を開始してください。",409,"PREVIEW_ACTIVE_RUN");}}
    const [limit]=await tx.select().from(higuchiPreviewDailyLimits).where(eq(higuchiPreviewDailyLimits.ipDayHash,ipHash));
    if((limit?.runs??0)>=3)throw new ProductError("本日の無料調査は3回までです。明日もう一度お試しください。",429,"PREVIEW_DAILY_LIMIT");
    // Expired cookies receive fresh entropy rather than reviving the old token.
    const freshToken=session?token:randomBytes(32).toString("base64url");
    if(!session)[session]=await tx.insert(higuchiPreviewSessions).values({tokenHash:previewTokenHash(freshToken),expiresAt:new Date(now.getTime()+TTL)}).returning();
    await tx.insert(higuchiPreviewDailyLimits).values({ipDayHash:ipHash,day,runs:1}).onConflictDoUpdate({target:higuchiPreviewDailyLimits.ipDayHash,set:{runs:sql`${higuchiPreviewDailyLimits.runs}+1`}});
    const [run]=await tx.insert(higuchiPreviewRuns).values({sessionId:session.id,input,state:markPreviewFixtureState(emptyPreviewState()),expiresAt:session.expiresAt}).returning();
    return {snapshot:previewSnapshot(run),cookie:previewCookie(freshToken)};
  });
}
export async function lockOwnedPreview(tx:PreviewTransaction,request:Request,id:string):Promise<PreviewRun> {
  assertId(id);const token=readPreviewToken(request);if(!token)throw new ProductError("調査が見つかりません。",404,"PREVIEW_NOT_FOUND");
  const [session]=await tx.select({id:higuchiPreviewSessions.id}).from(higuchiPreviewSessions).where(and(eq(higuchiPreviewSessions.tokenHash,previewTokenHash(token)),gt(higuchiPreviewSessions.expiresAt,new Date())));
  if(!session)throw new ProductError("調査の有効期限が切れています。",404,"PREVIEW_NOT_FOUND");
  const [run]=await tx.select().from(higuchiPreviewRuns).where(and(eq(higuchiPreviewRuns.id,id),eq(higuchiPreviewRuns.sessionId,session.id),gt(higuchiPreviewRuns.expiresAt,new Date()))).for("update");
  if(!run)throw new ProductError("調査が見つかりません。",404,"PREVIEW_NOT_FOUND");return run;
}
export async function markPreviewClaimed(tx:PreviewTransaction,run:PreviewRun,organizationId:string,projectId:string):Promise<void> {
  if(run.status==="claimed"){if(run.claimedOrganizationId!==organizationId||run.claimedProjectId!==projectId)throw new ProductError("この調査はすでに取り込まれています。",409,"PREVIEW_ALREADY_CLAIMED");return;}
  if(run.status!=="ready")throw new ProductError("調査の完了をお待ちください。",409,"PREVIEW_NOT_READY");
  await tx.update(higuchiPreviewRuns).set({status:"claimed",claimedOrganizationId:organizationId,claimedProjectId:projectId,claimedAt:new Date(),updatedAt:new Date(),revision:run.revision+1,lockedBy:null,leaseUntil:null}).where(and(eq(higuchiPreviewRuns.id,run.id),eq(higuchiPreviewRuns.sessionId,run.sessionId)));
}
export async function getPreview(request:Request,id:string):Promise<PreviewSnapshot>{return db.transaction(async tx=>previewSnapshot(await lockOwnedPreview(tx,request,id)));}
export async function patchPreview(request:Request,id:string,input:PatchPreviewInput):Promise<PreviewSnapshot>{
  return db.transaction(async tx=>{
    const run=await lockOwnedPreview(tx,request,id);assertPreviewRevision(run.revision,input.revision);
    if(run.status==="claimed")throw new ProductError("取り込み済みの調査は変更できません。",409,"PREVIEW_ALREADY_CLAIMED");
    const patch:Partial<typeof higuchiPreviewRuns.$inferInsert>={revision:run.revision+1,updatedAt:new Date()};
    if(input.action.type==="retry"){
      if(run.status!=="failed"||!run.errorRetryable||run.retryCount>=2)throw new ProductError("この調査は再試行できません。",409,"PREVIEW_RETRY_LIMIT");
      Object.assign(patch,{status:"queued",attempts:0,retryCount:run.retryCount+1,lockedBy:null,leaseUntil:null,runAfter:new Date(),errorCode:null,errorMessage:null,errorRetryable:0,generation:run.generation+1});
    }else{
      const state=structuredClone(run.state),oldCompany=run.state.company,{restart}=applyPreviewEdit(state,input.action);patch.state=state;
      if(restart){
        if(run.retryCount>=2)throw new ProductError("変更後の再調査は2回までです。",429,"PREVIEW_RETRY_LIMIT");
        const company=state.company!;patch.input={website:company.website,business:company.business,customer:company.customer,geography:company.geography};
        const restartAt=oldCompany&&oldCompany.website===company.website&&oldCompany.business===company.business&&state.stages[1].status==="completed"?2:0;
        if(restartAt===0)state.competitors=[];state.campaigns=[];state.companies=[];state.candidates=[];state.drafts=[];state.selectedCampaignId=null;
        state.stages=state.stages.map((s,i)=>i<restartAt?s:{stage:s.stage,status:"pending"});
        Object.assign(patch,{stageIndex:restartAt,status:"queued",attempts:0,retryCount:run.retryCount+1,generation:run.generation+1,lockedBy:null,leaseUntil:null,runAfter:new Date(),errorCode:null,errorMessage:null,errorRetryable:0});
      }else if(input.action.type==="edit_campaign"){
        if(run.retryCount>=2)throw new ProductError("変更後の再調査は2回までです。",429,"PREVIEW_RETRY_LIMIT");
        const restartAt=Math.min(run.stageIndex,3);state.companies=[];state.candidates=[];state.drafts=[];state.stages=state.stages.map((s,i)=>i<restartAt?s:{stage:s.stage,status:"pending"});
        Object.assign(patch,{stageIndex:restartAt,status:"queued",attempts:0,retryCount:run.retryCount+1,generation:run.generation+1,lockedBy:null,leaseUntil:null,runAfter:new Date(),errorCode:null,errorMessage:null,errorRetryable:0});
      }
    }
    const [saved]=await tx.update(higuchiPreviewRuns).set(patch).where(and(eq(higuchiPreviewRuns.id,id),eq(higuchiPreviewRuns.sessionId,run.sessionId))).returning();return previewSnapshot(saved);
  });
}
export type PreviewClaim={run:PreviewRun;owner:string;slot:number};
export async function claimPreviewStage(preferredId?:string):Promise<PreviewClaim|null>{
  return db.transaction(async tx=>{
    await tx.execute(sql`insert into higuchi_preview_worker_slots(slot) values(1),(2) on conflict do nothing`);
    const slots=await tx.execute<{slot:number}>(sql`select slot from higuchi_preview_worker_slots where lease_until is null or lease_until<now() order by slot for update skip locked limit 1`);
    if(!slots.length)return null;const slot=Number(slots[0].slot),owner=randomUUID(),now=new Date();
    const rows=await tx.select().from(higuchiPreviewRuns).where(and(gt(higuchiPreviewRuns.expiresAt,now),sql`${higuchiPreviewRuns.runAfter}<=now()`,sql`(${higuchiPreviewRuns.status}='queued' or (${higuchiPreviewRuns.status}='running' and ${higuchiPreviewRuns.leaseUntil}<now()))`,...(preferredId?[eq(higuchiPreviewRuns.id,preferredId)]:[]))).orderBy(higuchiPreviewRuns.runAfter).for("update",{skipLocked:true}).limit(1);
    if(!rows.length)return null;const run=rows[0];
    if(run.attempts>=3){await tx.update(higuchiPreviewRuns).set({status:"failed",lockedBy:null,leaseUntil:null,errorCode:"PREVIEW_INTERRUPTED",errorMessage:"処理が中断しました。再試行してください。",errorRetryable:1,revision:run.revision+1,updatedAt:now}).where(eq(higuchiPreviewRuns.id,run.id));return null;}
    const leaseUntil=new Date(now.getTime()+LEASE_MS),state=structuredClone(run.state);state.stages[run.stageIndex]={stage:PREVIEW_STAGES[run.stageIndex],status:"running"};
    await tx.update(higuchiPreviewWorkerSlots).set({owner,leaseUntil}).where(eq(higuchiPreviewWorkerSlots.slot,slot));
    const [saved]=await tx.update(higuchiPreviewRuns).set({status:"running",lockedBy:owner,leaseUntil,attempts:run.attempts+1,state,updatedAt:now,revision:run.revision+1}).where(eq(higuchiPreviewRuns.id,run.id)).returning();return {run:saved,owner,slot};
  });
}
export async function settlePreviewStage(claim:PreviewClaim,state:PreviewState,error?:{code:string;message:string;retryable:boolean}):Promise<boolean>{
  return db.transaction(async tx=>{
    const run=claim.run,now=new Date(),next=run.stageIndex+1;
    const [current]=await tx.select().from(higuchiPreviewRuns).where(and(eq(higuchiPreviewRuns.id,run.id),eq(higuchiPreviewRuns.lockedBy,claim.owner),eq(higuchiPreviewRuns.generation,run.generation),gt(higuchiPreviewRuns.leaseUntil,now),gt(higuchiPreviewRuns.expiresAt,now))).for("update");
    // Stage completion only updates its own fields. Campaign/tab edits made while AI was running survive.
    let saved=false;
    if(current){const merged=structuredClone(current.state);if(!error){switch(PREVIEW_STAGES[run.stageIndex]){case "company":merged.company=state.company;break;case "competitors":merged.competitors=state.competitors;break;case "campaigns":merged.campaigns=state.campaigns;merged.selectedCampaignId=state.selectedCampaignId;break;case "candidates":Object.assign(merged,{companies:state.companies,candidates:state.candidates,sample:state.sample,notice:state.notice});break;case "verification":merged.candidates=state.candidates;merged.campaigns=merged.campaigns.map(c=>({...c,estimatedLeads:state.campaigns.find(x=>x.id===c.id)?.estimatedLeads??null}));break;case "drafts":merged.drafts=state.drafts;break;}}
      merged.stages[run.stageIndex]={stage:PREVIEW_STAGES[run.stageIndex],status:error?"failed":"completed",...(!error?{completedAt:now.toISOString()}:{})};
      await tx.update(higuchiPreviewRuns).set({state:merged,status:error?"failed":next===PREVIEW_STAGES.length?"ready":"queued",stageIndex:error?run.stageIndex:next,attempts:error?run.attempts:0,lockedBy:null,leaseUntil:null,runAfter:now,updatedAt:now,revision:current.revision+1,errorCode:error?.code??null,errorMessage:error?.message??null,errorRetryable:error?.retryable?1:0}).where(and(eq(higuchiPreviewRuns.id,run.id),eq(higuchiPreviewRuns.lockedBy,claim.owner)));saved=true;}
    await tx.update(higuchiPreviewWorkerSlots).set({owner:null,leaseUntil:null}).where(and(eq(higuchiPreviewWorkerSlots.slot,claim.slot),eq(higuchiPreviewWorkerSlots.owner,claim.owner)));return saved;
  });
}
