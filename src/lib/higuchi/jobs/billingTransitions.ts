import { id, recordActivity, type BillingJob, type WorkspaceState } from "../state";

export function claimBillingEntry(state:WorkspaceState,entryId:string):BillingJob|null {
  const entry=state.internal.billingJobs.find(job=>job.id===entryId),now=Date.parse(state.now);
  if(!entry||["complete","failed"].includes(entry.status)||entry.status==="running"&&now-Date.parse(entry.lockedAt??state.now)<180000||entry.retryAt&&Date.parse(entry.retryAt)>now)return null;
  entry.status="running";entry.lockedAt=state.now;
  // Persist before any provider write. Never reset on timeout, lease recovery, or a later queue attempt.
  entry.firstAttemptAt??=state.now;entry.attempts=(entry.attempts??0)+1;
  return structuredClone(entry);
}
function heldEntry(state:WorkspaceState,claim:BillingJob):BillingJob|undefined {
  return state.internal.billingJobs.find(entry=>entry.id===claim.id&&entry.status==="running"&&entry.lockedAt===claim.lockedAt);
}
export function completeBillingEntry(state:WorkspaceState,claim:BillingJob,subscriptionId?:string):boolean {
  const current=heldEntry(state,claim);if(!current)return false;
  current.status="complete";current.lockedAt=undefined;current.retryAt=undefined;current.error=undefined;
  if(subscriptionId)state.billing.subscriptionId=subscriptionId;
  const available=()=>!state.billing.reconciliationRequired&&state.billing.paymentStatus!=="failed";
  if(claim.kind==="configure"&&available()){
    state.billing.postpaidEnabled=true;
    if(state.ledger.some(entry=>entry.kind==="trial"||entry.kind==="topup")){state.billing.billingConfigured=true;state.billing.paymentStatus="verified";}
  }
  if(claim.kind==="trial"||claim.kind==="topup"){
    const amount=claim.kind==="trial"?3000:claim.creditCents;
    if(!Number.isSafeInteger(amount)||!amount||amount<0)throw new Error("利用クレジットの金額が正しくありません。");
    if(!state.ledger.some(entry=>entry.dedupeKey===claim.id)){
      state.billing.balanceCents+=amount;state.billing.pendingCreditCents=Math.max(0,state.billing.pendingCreditCents-amount);
      state.ledger.unshift({id:id("entry"),projectId:null,campaignId:null,at:state.now,kind:claim.kind,amountCents:amount,description:claim.kind==="trial"?"初回無料クレジット":"支払確認済みクレジット",dedupeKey:claim.id});
    }
    if(available()&&state.billing.postpaidEnabled){state.billing.billingConfigured=true;state.billing.paymentStatus="verified";}
    if(claim.kind==="topup")state.billing.topupStatus="completed";
  }
  return true;
}
export function failBillingEntry(state:WorkspaceState,claim:BillingJob,permanent:boolean):boolean {
  const current=heldEntry(state,claim);if(!current)return false;
  current.status=permanent?"failed":"pending";current.lockedAt=undefined;
  current.retryAt=permanent?undefined:new Date(Date.parse(state.now)+Math.min(3600000,30000*2**Math.min(current.attempts??1,7))).toISOString();
  current.error="課金サービスへの反映を確認してください。";
  if(permanent){
    state.billing.reconciliationRequired=true;state.billing.paymentStatus="failed";state.billing.billingConfigured=false;state.billing.postpaidEnabled=false;
    for(const out of state.internal.outbox)if(["reserved","preparing"].includes(out.status))out.status="cancelled";
  }
  recordActivity(state,permanent?"課金結果の照合が必要です。送信を停止しました。":"課金サービスへの反映を再試行します。","warning");
  return true;
}
