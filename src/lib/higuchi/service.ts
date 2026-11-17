import { isHiguchiSimulation, isLoopbackHost } from "./mode";
import { applyAction, runWorkspaceTick } from "./engine";
import { createWorkspace, ProductError, snapshot, type WorkspaceState } from "./state";
import { mutateLive, mutateSimulation, resolveSimulationSession, type WorkspaceMutation } from "./store";
import type { WorkspaceAction, WorkspaceSnapshot } from "./types";
import type { VerifiedBillingEvent } from "./providerBilling";
import { applyBillingEvent } from "./billingState";
import { readJsonObject, validateAction } from "./validation";
import { billingPolicy } from "./money";

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  let supplied:URL;try{supplied=new URL(origin??"");}catch{throw new ProductError("同じサイトから操作を実行してください。",403,"INVALID_ORIGIN");}
  const internal=new URL(request.url);
  if(isHiguchiSimulation()){
    let host:URL;try{host=new URL(`${internal.protocol}//${request.headers.get("host")??internal.host}`);}catch{throw new ProductError("同じサイトから操作を実行してください。",403,"INVALID_ORIGIN");}
    if(isLoopbackHost(supplied.hostname)&&isLoopbackHost(host.hostname)&&supplied.protocol===host.protocol&&supplied.port===host.port)return;
  }else{
    const configured=process.env.BETTER_AUTH_URL??process.env.NEXT_PUBLIC_APP_URL;
    const expected=configured?new URL(configured).origin:internal.origin;
    if(supplied.origin===expected)return;
  }
  throw new ProductError("同じサイトから操作を実行してください。",403,"INVALID_ORIGIN");
}
export async function parseAction(request: Request): Promise<WorkspaceAction> {
  return validateAction(await readJsonObject(request));
}
type WorkspaceResult = { workspace: WorkspaceSnapshot; cookie: string | null };
async function simulation<T>(request: Request, fn: WorkspaceMutation<T>): Promise<{state:WorkspaceState; cookie:string|null; result:T}> {
  const session = await resolveSimulationSession(request); const changed = await mutateSimulation(session.id, fn);
  return { ...changed, cookie: session.cookie };
}
export async function readWorkspace(request: Request): Promise<WorkspaceResult> {
  if (isHiguchiSimulation()) { const result = await simulation(request, (state) => { delete state.redirectUrl; runWorkspaceTick(state); }); return {workspace:snapshot(result.state),cookie:result.cookie}; }
  const { withOrgContext } = await import("@/lib/auth/context");
  return withOrgContext(request, async (ctx) => {
    const { getIntegrationStates } = await import("./integrations"); const integrations = await getIntegrationStates(ctx.organizationId);
    const result = await mutateLive((state) => { delete state.redirectUrl; state.integrations = integrations; });
    return { workspace:snapshot(result.state), cookie:null };
  });
}
export async function dispatchWorkspace(request: Request, action: WorkspaceAction): Promise<WorkspaceResult> {
  if (isHiguchiSimulation()) {
    const result = await simulation(request, async (state) => {
      if (action.type === "simulation.reset") { const fresh = createWorkspace("simulation"); Object.assign(state, fresh); }
      else if (action.type === "billing.setup") applyAction(state, {type:"billing.verify",requestId:action.requestId});
      else if (action.type === "billing.checkout") applyAction(state, {type:"billing.topup",amountCents:action.amountCents,requestId:action.requestId});
      else if (action.type === "billing.portal") state.notice = "シミュレーションでは実際の決済管理画面は開きません。";
      else applyAction(state, action);
      if(action.type==="project.create"){
        const p=state.projects.at(-1)!;const {simulatedBusinessAnalysis}=await import("./analysis");
        const analysis=simulatedBusinessAnalysis({organizationId:"simulation",website:p.website,business:p.description,customer:p.icp,geo:p.geography});
        p.description=analysis.business;p.icp=analysis.customer;p.geography=analysis.geo||p.geography;p.segments=analysis.segments;p.analysisSources=["シミュレーション：サイトの実取得は行っていません"];
      }
      runWorkspaceTick(state);
    });
    return { workspace:snapshot(result.state), cookie:result.cookie };
  }
  const { withOrgContext, requirePermission } = await import("@/lib/auth/context");
  return withOrgContext(request, async (ctx) => {
    if (action.type.startsWith("simulation.") || action.type === "billing.verify" || action.type === "billing.topup") throw new ProductError("検証用操作は本番環境では利用できません。", 403);
    if (action.type.startsWith("billing.") || action.type === "settings.update") requirePermission(ctx, { integrations:["manage"] });
    const integrations = await import("./integrations"); const statuses = await integrations.getIntegrationStates(ctx.organizationId);
    const returnUrl = new URL("/app/billing",request.url).href;
    if (action.type === "billing.setup" || action.type === "billing.checkout" || action.type === "billing.portal") {
      if (!statuses.billing.connected) throw new ProductError("運営側の決済接続が未設定です。",409,"BILLING_UNCONFIGURED");
      const billing = await import("./providerBilling"); let redirectUrl: string;
      if(typeof action.requestId!=="string"||!action.requestId.trim()||action.requestId.length>200)throw new ProductError("リクエストIDを指定してください。");
      const currentBilling=(await mutateLive(state=>structuredClone(state.billing))).result;
      if(action.type!=="billing.portal"&&currentBilling.reconciliationRequired)throw new ProductError("返金・残高の照合が完了するまで、新しいカード登録・前払いを停止しています。運営者にご連絡ください。",409,"BILLING_RECONCILIATION_REQUIRED");
      if (action.type === "billing.setup") redirectUrl = (await billing.createBillingSetup({organizationId:ctx.organizationId,currency:currentBilling.currency,returnUrl,requestId:action.requestId,email:ctx.userEmail})).url;
      else if (action.type === "billing.checkout") {
        if (!Number.isSafeInteger(action.amountCents) || !(billingPolicy(currentBilling.currency).topupMinor as readonly number[]).includes(action.amountCents)) throw new ProductError("指定できない前払い金額です。");
        redirectUrl = (await billing.createBillingCheckout({organizationId:ctx.organizationId,currency:currentBilling.currency,amountCents:action.amountCents,returnUrl,requestId:action.requestId,firstPaymentBonus:!currentBilling.firstTopupCompleted&&!currentBilling.trialClaimed})).url;
      } else { if (!currentBilling.customerId) throw new ProductError("決済設定を先に完了してください。",409); redirectUrl = (await billing.createBillingPortal({organizationId:ctx.organizationId,currency:currentBilling.currency,customerId:currentBilling.customerId,returnUrl})).url; }
      const result = await mutateLive((state) => { state.integrations=statuses; state.redirectUrl=redirectUrl; if(action.type !== "billing.portal") {state.billing.paymentStatus="pending";state.billing.topupStatus="pending";} });
      return { workspace:snapshot(result.state),cookie:null };
    }
    const {enqueueJob}=await import("./jobs/store");
    const {scheduleWorkspaceJobs}=await import("./jobs/handlers");
    const {enqueueOwnerNotice}=await import("./jobs/ownerNotifications");
    const result=await mutateLive(async(state,tx)=>{
      const previous=new Map(state.campaigns.map(campaign=>[campaign.id,campaign.status]));
      state.integrations=statuses;applyAction(state,action);
      for(const campaign of state.campaigns)if(previous.has(campaign.id)&&previous.get(campaign.id)!==campaign.status)await enqueueOwnerNotice(tx,{organizationId:ctx.organizationId,enabled:state.settings.emailNotifications,kind:"campaign",requestId:`${campaign.id}:${campaign.status}:${state.activity[0]?.id??state.now}`});
      if(action.type==="project.create"){
        const project=state.projects.at(-1)!;project.status="analyzing";
        await enqueueJob({organizationId:ctx.organizationId,kind:"business.analyze",entityId:project.id,idempotencyKey:project.id},tx);
      }
      await scheduleWorkspaceJobs(state,ctx.organizationId,tx);
    });
    return { workspace:snapshot(result.state),cookie:null };
  });
}

export async function applyVerifiedBillingEvent(event:VerifiedBillingEvent):Promise<void> {
  if(isHiguchiSimulation())throw new ProductError("検証環境では決済通知を受け付けません。",409);
  const [{runInOrganization},{scheduleWorkspaceJobs},{enqueueOwnerNotice}]=await Promise.all([import("@/lib/tenancy/scope"),import("./jobs/handlers"),import("./jobs/ownerNotifications")]);
  await runInOrganization(event.organizationId,()=>mutateLive(async(state,tx)=>{applyBillingEvent(state,event);if(event.kind==="refund"){const {syncGuaranteeRefund}=await import("./guarantee");await syncGuaranteeRefund(tx,event);}if(event.kind==="payment_failed"||event.kind==="refund")await enqueueOwnerNotice(tx,{organizationId:event.organizationId,enabled:state.settings.emailNotifications,kind:"billing",requestId:event.eventId});await scheduleWorkspaceJobs(state,event.organizationId,tx);}));
}
export async function runHiguchiTick():Promise<void>{await (await import("./jobs/worker")).runHiguchiJobs();}
/** Platform cron is the sole production scheduler. */
export function startHiguchiScheduler():void{}
