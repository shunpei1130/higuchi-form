import type { VerifiedBillingEvent } from "./providerBilling";
import { id, ProductError, recordActivity, type WorkspaceState } from "./state";
import { billingPolicy } from "./money";

/** Verified provider events only. Caller persists this whole transition under the tenant row lock. */
export function applyBillingEvent(state:WorkspaceState,event:VerifiedBillingEvent&{refundChargeId?:string}):void {
  if(!event.eventId||event.eventId.length>500||!Number.isSafeInteger(event.amountCents)||event.amountCents<0)throw new ProductError("決済通知が正しくありません。");
  if(state.internal.providerEvents.includes(event.eventId))return;
  if(event.currency&&event.currency!==state.billing.currency)throw new ProductError("以前の通貨の決済通知です。運営者による残高照合が必要です。",409,"BILLING_CURRENCY_MISMATCH");
  const policy=billingPolicy(state.billing.currency);
  if(state.billing.customerId&&event.providerCustomerId&&state.billing.customerId!==event.providerCustomerId)throw new ProductError("決済顧客が一致しません。",400);
  state.internal.providerEvents.push(event.eventId);state.internal.billingJobs??=[];state.internal.refundTotals??={};
  if(event.providerCustomerId)state.billing.customerId=event.providerCustomerId;
  if(event.providerSubscriptionId){if(state.billing.subscriptionId&&state.billing.subscriptionId!==event.providerSubscriptionId)throw new ProductError("決済契約が一致しません。",400);state.billing.subscriptionId=event.providerSubscriptionId;}
  const stale=event.providerCreatedAt!==undefined&&event.providerCreatedAt<(state.billing.lastProviderEventCreatedAt??0);
  if(event.previewRunId&&event.checkoutSessionId&&(event.kind==="setup"||event.kind==="topup")){
    const pending=state.billing.pendingPreviewSessions?.[event.previewRunId];
    if(pending?.sessionId===event.checkoutSessionId){state.billing.verifiedPreviewSessions??={};state.billing.verifiedPreviewSessions[event.previewRunId]={sessionId:event.checkoutSessionId,mode:event.kind==="setup"?"setup":"payment",amountMinor:event.amountCents,currency:state.billing.currency,verifiedAt:event.purchasedAt??state.now};}
  }
  if(event.providerCreatedAt!==undefined)state.billing.lastProviderEventCreatedAt=Math.max(state.billing.lastProviderEventCreatedAt??0,event.providerCreatedAt);
  if(event.reconciliationRequired||event.kind==="refund")state.billing.reconciliationRequired=true;
  const queue=(kind:"trial"|"topup"|"configure",creditCents?:number)=>{
    const jobId=`${kind}:${event.eventId}`;
    if(!state.internal.billingJobs.some(j=>j.id===jobId))state.internal.billingJobs.push({id:jobId,kind,status:"pending",currency:state.billing.currency,priceVersion:policy.priceVersion,amountCents:event.amountCents,creditCents,at:state.now});
  };
  if(event.kind==="setup"){
    if(!stale&&!state.billing.reconciliationRequired)state.billing.paymentStatus="pending";
    if(!state.billing.trialClaimed&&!state.billing.firstTopupCompleted){state.billing.trialClaimed=true;state.billing.pendingCreditCents+=policy.trialMinor;queue("trial",policy.trialMinor);}
    queue("configure");recordActivity(state,"カード確認が完了しました。無料クレジットと従量課金の設定を反映中です。","info");
  }else if(event.kind==="topup"){
    const proposed=event.creditCents??event.amountCents;
    if(!Number.isSafeInteger(proposed)||proposed<event.amountCents||proposed>event.amountCents*2)throw new ProductError("クレジット金額が正しくありません。");
    const credit=state.billing.firstTopupCompleted||state.billing.trialClaimed?event.amountCents:proposed;
    if(!state.billing.firstTopupCompleted&&!state.billing.firstPrepayment)state.billing.firstPrepayment={sessionId:event.eventId.replace(/^stripe-topup:/,""),paymentIntentId:event.paymentIntentId,chargeId:event.chargeId,amountMinor:event.amountCents,currency:state.billing.currency,priceVersion:policy.priceVersion,purchasedAt:event.purchasedAt??state.now};
    state.billing.firstTopupCompleted=true;
    if(!stale&&!state.billing.reconciliationRequired)state.billing.paymentStatus="pending";
    state.billing.pendingCreditCents+=credit;state.billing.topupStatus="pending";queue("topup",credit);queue("configure");
    recordActivity(state,"入金を確認しました。課金サービスへの反映後にクレジットを利用できます。","success");
  }else if(event.kind==="payment_failed"){
    if(stale&&!event.reconciliationRequired)return;
    state.billing.paymentStatus="failed";state.billing.billingConfigured=false;state.billing.postpaidEnabled=false;state.billing.topupStatus="failed";
    for(const out of state.internal.outbox)if(out.status==="reserved")out.status="cancelled";
    recordActivity(state,"支払いを確認できないため、メール送信を停止しました。決済設定を確認してください。","warning");
  }else if(event.kind==="payment_paid"){
    // This is verified usage paid outside Billing Credit Grants. Settle once even if a later topup arrived first.
    const payment=event.amountCents;
    if(payment>0){state.billing.balanceCents+=payment;state.ledger.unshift({id:id("entry"),projectId:null,campaignId:null,at:state.now,kind:"topup",currency:state.billing.currency,priceVersion:policy.priceVersion,amountCents:payment,description:"従量利用料金の精算",dedupeKey:event.eventId});}
    if(!stale&&!state.billing.reconciliationRequired){state.billing.paymentStatus="pending";state.billing.billingConfigured=false;state.billing.postpaidEnabled=false;queue("configure");}
    recordActivity(state,"利用料金の支払いを確認しました。","success");
  }else if(event.kind==="refund"){
    const charge=event.refundChargeId??event.eventId.replace(/:[0-9]+$/,""),previous=state.internal.refundTotals[charge]??0;
    const amount=Math.max(0,event.amountCents-previous);state.internal.refundTotals[charge]=Math.max(previous,event.amountCents);
    if(amount){state.billing.balanceCents-=amount;state.ledger.unshift({id:id("entry"),projectId:null,campaignId:null,at:state.now,kind:"refund",currency:state.billing.currency,priceVersion:policy.priceVersion,amountCents:-amount,description:"返金に伴うクレジット調整",dedupeKey:event.eventId});}
    state.billing.postpaidEnabled=false;state.billing.billingConfigured=false;state.billing.paymentStatus="failed";
    for(const out of state.internal.outbox)if(out.status==="reserved")out.status="cancelled";
    recordActivity(state,"返金を記録しました。課金サービスの残高調整を確認するまで送信を停止します。","warning");
  }
}
