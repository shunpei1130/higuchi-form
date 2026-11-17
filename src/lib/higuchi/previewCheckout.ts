import { randomUUID } from "node:crypto";
import { activateJpyBilling, ProductError, type WorkspaceState } from "./state";
import type { BillingElementsSession } from "./providerBilling";

export type PendingPreviewCheckout=NonNullable<WorkspaceState["billing"]["pendingPreviewSessions"]>[string];
type Selection={mode:"setup"|"payment";amountMinor:number;currency:"JPY"};
export type PreviewCheckoutDependencies={
  mutate:<T>(fn:(state:WorkspaceState)=>T)=>Promise<T>;
  create:(pending:PendingPreviewCheckout)=>Promise<{sessionId:string}>;
  read:(sessionId:string)=>Promise<BillingElementsSession>;
  expire:(sessionId:string)=>Promise<BillingElementsSession>;
  now?:()=>number;owner?:()=>string;
};
const same=(left:Selection,right:PendingPreviewCheckout)=>left.mode===right.mode&&left.amountMinor===right.amountMinor&&left.currency===right.currency;
const confirmed=()=>new ProductError("カード確認を受け付けています。決済通知の反映をお待ちください。追加のお支払いは行わないでください。",409,"CHECKOUT_ALREADY_CONFIRMED");
const busy=()=>new ProductError("決済の準備中です。少し待って接続を再確認してください。カードへの請求は行っていません。",409,"CHECKOUT_PREPARING");
/** One durable operation per run. Remote calls happen outside the workspace row lock.
 * A crash retains the original request/parameters so Stripe idempotency recovers
 * the orphan before any changed plan can replace it. No secrets enter state. */
export async function preparePreviewCheckout(input:{runId:string;mode:"setup"|"payment";amountMinor?:number;requestId:string;returnUrl:string},deps:PreviewCheckoutDependencies):Promise<BillingElementsSession>{
  const desired:Selection={mode:input.mode,amountMinor:input.mode==="setup"?0:input.amountMinor??0,currency:"JPY"};
  if(desired.mode==="payment"&&![4500,7500,15000].includes(desired.amountMinor))throw new ProductError("前払い金額を確認してください。");
  const now=deps.now??Date.now,owner=(deps.owner??randomUUID)();
  const assertAllowed=(state:WorkspaceState)=>{
    activateJpyBilling(state);
    if(state.billing.reconciliationRequired)throw new ProductError("返金・残高の照合が完了するまで前払いを停止しています。",409,"BILLING_RECONCILIATION_REQUIRED");
    if(state.billing.verifiedPreviewSessions?.[input.runId])throw confirmed();
  };
  const newPending=(state:WorkspaceState):PendingPreviewCheckout=>({...desired,sessionId:"",requestId:randomUUID(),returnUrl:input.returnUrl,createdAt:new Date(now()).toISOString(),firstPaymentBonus:!state.billing.firstTopupCompleted&&!state.billing.trialClaimed,lockId:owner,leaseUntil:new Date(now()+120000).toISOString()});
  const initial=await deps.mutate(state=>{
    if(state.billing.verifiedPreviewSessions?.[input.runId]){
      const value=state.billing.pendingPreviewSessions?.[input.runId];if(value){delete value.lockId;delete value.leaseUntil;}
      return null;
    }
    assertAllowed(state);state.billing.pendingPreviewSessions??={};
    const current=state.billing.pendingPreviewSessions[input.runId];
    if(current?.lockId&&Date.parse(current.leaseUntil??"")>now())throw busy();
    const value=current??newPending(state);
    value.lockId=owner;value.leaseUntil=new Date(now()+120000).toISOString();
    state.billing.pendingPreviewSessions[input.runId]=value;
    return structuredClone(value);
  });
  if(!initial)throw confirmed();
  let pending=initial;
  const update=<T>(fn:(state:WorkspaceState,value:PendingPreviewCheckout)=>T)=>deps.mutate(state=>{
    assertAllowed(state);const current=state.billing.pendingPreviewSessions?.[input.runId];
    if(!current||current.lockId!==owner)throw busy();return fn(state,current);
  });
  async function resolveSession():Promise<BillingElementsSession>{
    let session:BillingElementsSession;
    if(pending.sessionId)session=await deps.read(pending.sessionId);
    else{
      // Stripe may prune idempotency keys after 24h. Unknown legacy/old attempts
      // require operator recovery instead of risking another chargeable Session.
      const createdAt=Date.parse(pending.createdAt??"");
      if(!pending.requestId||!pending.returnUrl||!Number.isFinite(createdAt)||now()<createdAt||now()-createdAt>=23*60*60*1000)throw new ProductError("以前の決済準備を照合する必要があります。追加のお支払いは行わず、運営者へご連絡ください。",409,"CHECKOUT_RECOVERY_REQUIRED");
      const created=await deps.create(pending);
      await update((_state,current)=>{if(current.requestId!==pending.requestId)throw busy();current.sessionId=created.sessionId;});
      pending={...pending,sessionId:created.sessionId};
      session=await deps.read(created.sessionId);
    }
    if(session.mode!==pending.mode||session.amountMinor!==pending.amountMinor||session.currency!==pending.currency)throw new ProductError("決済内容を照合できません。追加のお支払いは行わず、運営者へご連絡ください。",409,"CHECKOUT_SESSION_MISMATCH");
    if(session.status==="complete")throw confirmed();
    return session;
  }
  try{
    let session=await resolveSession();
    if(session.status==="open"&&same(desired,pending))return session;
    if(session.status==="open"){
      // If confirmation wins this race, expiration fails and no replacement may
      // be created. The signed receipt remains tied to the previous Session.
      try{session=await deps.expire(session.sessionId);}catch(error){const current=await deps.read(session.sessionId);if(current.status==="complete")throw confirmed();if(current.status!=="expired")throw error;session=current;}
    }
    if(session.status!=="expired")throw busy();
    pending=await update((state)=>{const value=newPending(state);state.billing.pendingPreviewSessions![input.runId]=value;return structuredClone(value);});
    const replacement=await resolveSession();
    if(replacement.status!=="open")throw busy();
    return replacement;
  }finally{
    await deps.mutate(state=>{const value=state.billing.pendingPreviewSessions?.[input.runId];if(value?.lockId===owner){delete value.lockId;delete value.leaseUntil;}}).catch(()=>{/* Lease recovery keeps the same durable request after a storage interruption. */});
  }
}
