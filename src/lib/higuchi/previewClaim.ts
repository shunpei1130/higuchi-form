import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth/server";
import { requirePermission, withOrgContext } from "@/lib/auth/context";
import { higuchiWorkspaces } from "./schema";
import { createWorkspace, normalizeWorkspaceState, ProductError, recordActivity } from "./state";
import { applyAction } from "./engine";
import { getIntegrationStates } from "./integrations";
import { scheduleWorkspaceJobs } from "./jobs/handlers";
import { lockOwnedPreview, markPreviewClaimed, type PreviewRun } from "./preview/store";
import { applyPreviewClaim, assertApprovedPreviewLeads, previewConsentKey, previewEntityId, releaseVerifiedPreviewLease, type ClaimedPreview } from "./previewClaimContract";
export { applyPreviewClaim, selectedPreviewDrafts, usablePreviewContact, previewEntityId } from "./previewClaimContract";
export type { ClaimedPreview } from "./previewClaimContract";

async function requireVerified(request:Request){const session=await auth.api.getSession({headers:request.headers});if(!session?.user.emailVerified)throw new ProductError("メールアドレスの本人確認を完了してください。",403,"EMAIL_VERIFICATION_REQUIRED");}
/** Used by Elements before creating a Stripe Customer or Session. */
export async function assertClaimedRealPreview(request:Request,runId:string,organizationId:string):Promise<void>{
  await db.transaction(async tx=>{const run=await lockOwnedPreview(tx,request,runId);if(run.status!=="claimed"||run.claimedOrganizationId!==organizationId||run.state.sample||!run.claimedProjectId)throw new ProductError("取り込み済みの実データを確認してください。",409,"PREVIEW_NOT_CLAIMED");});
}
export async function recordPreviewConsent(request:Request,runId:string,expectedSessionId:string){
  await requireVerified(request);return withOrgContext(request,async ctx=>{
    requirePermission(ctx,{integrations:["manage"]});return db.transaction(async tx=>{
      const run=await lockOwnedPreview(tx,request,runId);if(run.status!=="claimed"||run.claimedOrganizationId!==ctx.organizationId||run.state.sample||!run.claimedProjectId)throw new ProductError("確認済みの調査結果を取り込んでください。",409,"PREVIEW_NOT_CLAIMED");
      const [row]=await tx.select().from(higuchiWorkspaces).where(eq(higuchiWorkspaces.organizationId,ctx.organizationId)).for("update");if(!row)throw new ProductError("ワークスペースが見つかりません。",404);
      const state=normalizeWorkspaceState(structuredClone(row.state)),pending=state.billing.pendingPreviewSessions?.[run.id];
      const released=releaseVerifiedPreviewLease(state,run.id,expectedSessionId);
      if(!/^cs_(?:test|live)_[A-Za-z0-9]+$/.test(expectedSessionId)||!pending?.sessionId||pending.sessionId!==expectedSessionId||("lockId" in pending&&pending.lockId))throw new ProductError("支払い画面が更新されました。再度支払わず、画面を再読み込みして確認してください。",409,"CHECKOUT_SESSION_CHANGED");
      const key=previewConsentKey(run,pending.sessionId),recorded=state.internal.processedRequests.includes(key);if(!recorded||released){if(!recorded){state.internal.processedRequests.push(key);recordActivity(state,"料金・返金条件と送信する宛先・文面の承認を記録しました。決済確認後に開始します。","info",run.claimedProjectId);}state.now=new Date().toISOString();await tx.update(higuchiWorkspaces).set({state,updatedAt:new Date()}).where(eq(higuchiWorkspaces.organizationId,ctx.organizationId));}
      return {consentRecorded:true,sessionId:pending.sessionId};
    });
  });
}
export async function claimPreviewForRequest(request:Request,runId:string,input:{revision:number;requestId:string}):Promise<ClaimedPreview>{
  await requireVerified(request);return withOrgContext(request,async ctx=>{
    requirePermission(ctx,{integrations:["manage"]});
    return db.transaction(async tx=>{
      const run=await lockOwnedPreview(tx,request,runId);
      if(run.status==="claimed"){
        if(run.claimedOrganizationId!==ctx.organizationId||!run.claimedProjectId)throw new ProductError("この調査はすでに取り込まれています。",409,"PREVIEW_ALREADY_CLAIMED");
        return {projectId:run.claimedProjectId,campaignIds:run.state.campaigns.map(c=>previewEntityId("campaign",run.id,ctx.organizationId,c.id)),sample:false,redirectUrl:`/app/campaigns/${previewEntityId("campaign",run.id,ctx.organizationId,run.state.selectedCampaignId??run.state.campaigns[0]?.id??"")}`};
      }
      if(run.revision!==input.revision)throw new ProductError("調査結果が更新されました。表示を確認して再度お進みください。",409,"PREVIEW_REVISION_CONFLICT");
      if(run.status!=="ready")throw new ProductError("調査の完了をお待ちください。",409,"PREVIEW_NOT_READY");
      await tx.insert(higuchiWorkspaces).values({organizationId:ctx.organizationId,state:createWorkspace("live")}).onConflictDoNothing();
      const [workspace]=await tx.select().from(higuchiWorkspaces).where(eq(higuchiWorkspaces.organizationId,ctx.organizationId)).for("update");
      const state=normalizeWorkspaceState(structuredClone(workspace.state));state.now=new Date().toISOString();
      const result=applyPreviewClaim(state,run.state,run.id,ctx.organizationId);
      await tx.update(higuchiWorkspaces).set({state,updatedAt:new Date()}).where(eq(higuchiWorkspaces.organizationId,ctx.organizationId));
      await markPreviewClaimed(tx,run,ctx.organizationId,result.projectId);return result;
    });
  });
}
export async function startClaimedPreview(request:Request,runId:string,requestId:string){
  await requireVerified(request);return withOrgContext(request,async ctx=>{
    requirePermission(ctx,{integrations:["manage"]});const integrations=await getIntegrationStates(ctx.organizationId);
    return db.transaction(async tx=>{
      const run:PreviewRun=await lockOwnedPreview(tx,request,runId);
      if(run.status!=="claimed"||run.claimedOrganizationId!==ctx.organizationId||run.state.sample||!run.claimedProjectId)throw new ProductError("実データの取り込みを完了してください。",409,"PREVIEW_NOT_CLAIMED");
      const [workspace]=await tx.select().from(higuchiWorkspaces).where(eq(higuchiWorkspaces.organizationId,ctx.organizationId)).for("update");if(!workspace)throw new ProductError("ワークスペースが見つかりません。",404);
      const state=normalizeWorkspaceState(structuredClone(workspace.state));state.now=new Date().toISOString();state.integrations=integrations;
      const selected=run.state.selectedCampaignId??run.state.campaigns[0]?.id,campaignId=previewEntityId("campaign",run.id,ctx.organizationId,selected??""),key=`preview-start:${run.id}:${requestId}`;
      if(state.internal.processedRequests.includes(key))return {started:true,projectId:run.claimedProjectId,campaignIds:[campaignId],redirectUrl:`/app/campaigns/${campaignId}`};
      if(!state.billing.billingConfigured||state.billing.paymentStatus!=="verified"||state.billing.currency!=="JPY")throw new ProductError("決済の反映を待っています。再度カードを入力せず、少し待ってから開始してください。",409,"BILLING_PENDING");
      const expected=state.billing.pendingPreviewSessions?.[run.id],verified=state.billing.verifiedPreviewSessions?.[run.id];
      if(expected?.sessionId)releaseVerifiedPreviewLease(state,run.id,expected.sessionId);
      if(!expected?.sessionId||("lockId" in expected&&expected.lockId)||!verified||expected.sessionId!==verified.sessionId||expected.mode!==verified.mode||expected.amountMinor!==verified.amountMinor||expected.currency!=="JPY"||verified.currency!=="JPY")throw new ProductError("この開始操作のカード登録・入金通知を確認しています。再度決済せず、反映をお待ちください。",409,"CHECKOUT_RECEIPT_PENDING");
      if(!state.internal.processedRequests.includes(previewConsentKey(run,expected.sessionId)))throw new ProductError("宛先・文面・料金と開始条件を再確認してください。",409,"START_CONSENT_REQUIRED");
      if(!integrations.email.connected||!integrations.booking.connected)throw new ProductError("送信元と予約受付の準備を完了してください。",409,"SEND_SETUP_REQUIRED");
      assertApprovedPreviewLeads(state,run.state,run.id,ctx.organizationId,run.claimedProjectId);
      const selectedCampaign=state.campaigns.find(campaign=>campaign.id===campaignId&&campaign.projectId===run.claimedProjectId);
      if(!selectedCampaign)throw new ProductError("キャンペーンが見つかりません。",404);
      selectedCampaign.autoReply=state.settings.autoReply;
      applyAction(state,{type:"campaign.start",campaignId});state.internal.processedRequests.push(key);recordActivity(state,"確認済みの宛先・文面と決済設定で営業を開始しました。","success",run.claimedProjectId);
      await scheduleWorkspaceJobs(state,ctx.organizationId,tx);await tx.update(higuchiWorkspaces).set({state,updatedAt:new Date()}).where(and(eq(higuchiWorkspaces.organizationId,ctx.organizationId)));return {started:true,projectId:run.claimedProjectId,campaignIds:[campaignId],redirectUrl:`/app/campaigns/${campaignId}`};
    });
  });
}
