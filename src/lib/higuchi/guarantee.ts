import "server-only";
import { and,eq,sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId,runInOrganization } from "@/lib/tenancy/scope";
import { organizations } from "@/lib/auth/schema";
import { higuchiRefundRequests } from "./guaranteeSchema";
import { higuchiBookings } from "./bookingSchema";
import { mutateLive } from "./store";
import { ProductError,recordActivity,type WorkspaceState } from "./state";
import { evaluateRefundGuarantee,type GuaranteeReceipt } from "./guaranteePolicy";
import type { JobsTransaction } from "./jobs/store";
import type { VerifiedBillingEvent } from "./providerBilling";

async function receipts(tx:JobsTransaction,state:WorkspaceState):Promise<GuaranteeReceipt[]>{
  const purchase=state.billing.firstPrepayment;if(!purchase)return [];
  const org=currentOrganizationId();const rows=await tx.execute<{message_id:string;accepted_at:Date;provider_message_id:string}>(sql`
    SELECT message_id,accepted_at,provider_message_id FROM (
    SELECT DISTINCT ON (r.provider_message_id) r.message_id,r.accepted_at,r.provider_message_id FROM higuchi_mail_receipts r
    JOIN higuchi_workspaces w ON w.organization_id=r.organization_id
    JOIN LATERAL jsonb_array_elements(w.state->'internal'->'outbox') o ON o->>'id'=r.message_id
    WHERE r.organization_id=${org}::uuid AND w.organization_id=${org}::uuid AND r.status='sent'
      AND r.provider_message_id IS NOT NULL AND r.accepted_at>=${purchase.purchasedAt}::timestamptz AND o->>'kind' IN ('initial','followup')
      AND o->>'status'='sent' AND coalesce((o->>'reservationCents')::integer,0)>0
    ORDER BY r.provider_message_id,r.accepted_at,r.message_id
    ) confirmed ORDER BY accepted_at,message_id LIMIT 1000`);
  return rows.map(row=>({messageId:row.message_id,acceptedAt:new Date(row.accepted_at).toISOString(),providerMessageId:row.provider_message_id}));
}
async function bookingEvidence(tx:JobsTransaction,state:WorkspaceState){const at=state.billing.firstPrepayment?.purchasedAt;if(!at)return [];const rows=await tx.select({campaignId:higuchiBookings.campaignId,leadId:higuchiBookings.leadId,createdAt:higuchiBookings.createdAt,status:higuchiBookings.status}).from(higuchiBookings).where(and(eq(higuchiBookings.organizationId,currentOrganizationId()),sql`${higuchiBookings.createdAt}>=${at}::timestamptz`)).limit(5000);return rows.map(row=>({campaignId:row.campaignId,leadId:row.leadId,bookedAt:row.createdAt.toISOString(),status:row.status}));}
export async function readGuarantee(){const org=currentOrganizationId();const result=await mutateLive(async(state,tx)=>{
  const summary=evaluateRefundGuarantee({billing:state.billing,outbox:state.internal.outbox,conversations:state.conversations,bookingEvidence:await bookingEvidence(tx,state),receipts:await receipts(tx,state)});
  const [request]=await tx.select().from(higuchiRefundRequests).where(eq(higuchiRefundRequests.organizationId,org)).limit(1);
  return {summary,request:request??null};});return result.result;}
export async function requestGuarantee(userId:string){const org=currentOrganizationId();const result=await mutateLive(async(state,tx)=>{
  const purchase=state.billing.firstPrepayment;if(!purchase)throw new ProductError("初回前払いの記録がありません。",409);
  const [previous]=await tx.select().from(higuchiRefundRequests).where(and(eq(higuchiRefundRequests.organizationId,org),eq(higuchiRefundRequests.sessionId,purchase.sessionId))).limit(1);if(previous)return previous;
  const summary=evaluateRefundGuarantee({billing:state.billing,outbox:state.internal.outbox,conversations:state.conversations,bookingEvidence:await bookingEvidence(tx,state),receipts:await receipts(tx,state)});
  if(!summary.canRequest||!summary.qualifiedAt)throw new ProductError(summary.reason,409,"GUARANTEE_NOT_ELIGIBLE");
  const [created]=await tx.insert(higuchiRefundRequests).values({organizationId:org,sessionId:purchase.sessionId,paymentIntentId:purchase.paymentIntentId,chargeId:purchase.chargeId,currency:purchase.currency,amountMinor:purchase.amountMinor,priceVersion:purchase.priceVersion,purchasedAt:new Date(purchase.purchasedAt),qualifiedAt:new Date(summary.qualifiedAt),sentCount:summary.sentCount,positiveCount:summary.positiveReplies,requestedBy:userId}).returning();
  recordActivity(state,"初回前払いの返金保証を申請しました。運営者が送信・返信記録を確認します。","info");return created;});return result.result;}
/** Called only after the Stripe event's signature, ownership and live resources are verified. */
export async function syncGuaranteeRefund(tx:JobsTransaction,event:VerifiedBillingEvent):Promise<void>{
  if(event.kind!=="refund"||!event.refundChargeId)return;
  const [request]=await tx.select().from(higuchiRefundRequests).where(and(eq(higuchiRefundRequests.organizationId,event.organizationId),eq(higuchiRefundRequests.chargeId,event.refundChargeId))).for("update");
  if(!request||event.amountCents<request.amountMinor||event.currency!==request.currency)return;
  await tx.update(higuchiRefundRequests).set({status:"refunded",note:"署名付きStripe通知で初回入金額の全額返金を確認しました。残存クレジットは照合対象として送信を停止しています。",updatedAt:new Date()}).where(and(eq(higuchiRefundRequests.id,request.id),eq(higuchiRefundRequests.organizationId,event.organizationId)));
}
/** Explicit operator capability resolves each tenant first; every business query still has its org predicate. */
export async function operatorRefundRequests(){
  const tenants=await db.select({id:organizations.id,name:organizations.name}).from(organizations).orderBy(organizations.createdAt).limit(500),all=[];
  for(const tenant of tenants){const requests=await runInOrganization(tenant.id,()=>db.select().from(higuchiRefundRequests).where(eq(higuchiRefundRequests.organizationId,tenant.id)).orderBy(sql`${higuchiRefundRequests.createdAt} desc`).limit(30));all.push(...requests.map(request=>({...request,organizationName:tenant.name})));}
  return all.sort((a,b)=>b.createdAt.getTime()-a.createdAt.getTime()).slice(0,200);
}
export async function operatorRefundEvidence(input:{organizationId:string;id:string}){
  return runInOrganization(input.organizationId,()=>mutateLive(async(state,tx)=>{
    const [request]=await tx.select().from(higuchiRefundRequests).where(and(eq(higuchiRefundRequests.id,input.id),eq(higuchiRefundRequests.organizationId,input.organizationId))).limit(1);if(!request)throw new ProductError("申請が見つかりません。",404);
    const confirmed=await receipts(tx,state),summary=evaluateRefundGuarantee({billing:state.billing,outbox:state.internal.outbox,conversations:state.conversations,bookingEvidence:await bookingEvidence(tx,state),receipts:confirmed});
    const accepted=new Map(confirmed.map(receipt=>[receipt.messageId,Date.parse(receipt.acceptedAt)])),first=new Map<string,number>();
    for(const out of state.internal.outbox){const at=accepted.get(out.id);if(at===undefined)continue;const key=`${out.campaignId}:${out.leadId}`;first.set(key,Math.min(first.get(key)??Infinity,at));}
    const cutoff=summary.qualifiedAt?Date.parse(summary.qualifiedAt):Date.now(),replies=[];
    for(const thread of state.conversations){const after=first.get(`${thread.campaignId}:${thread.leadId}`);if(after===undefined)continue;for(const message of thread.messages){if(message.direction==="inbound"&&Date.parse(message.sentAt)>=after&&Date.parse(message.sentAt)<=cutoff)replies.push({company:state.leads.find(lead=>lead.id===thread.leadId)?.company??"",at:message.sentAt,body:message.body.slice(0,5000)});}}
    return {summary,replies:replies.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(0,200)};
  }).then(result=>result.result));
}
export async function reviewGuaranteeRequest(input:{organizationId:string;id:string;status:"reviewing"|"approved"|"rejected";note:string;reviewedBy:string;overridePositive?:boolean}){
  return runInOrganization(input.organizationId,()=>mutateLive(async(state,tx)=>{
    const [request]=await tx.select().from(higuchiRefundRequests).where(and(eq(higuchiRefundRequests.id,input.id),eq(higuchiRefundRequests.organizationId,input.organizationId))).for("update");
    if(!request)throw new ProductError("返金申請が見つかりません。",404);if(request.status==="refunded")throw new ProductError("返金済みの申請は変更できません。",409);
    const summary=evaluateRefundGuarantee({billing:state.billing,outbox:state.internal.outbox,conversations:state.conversations,bookingEvidence:await bookingEvidence(tx,state),receipts:await receipts(tx,state)});
    if(input.status==="approved"&&(!summary.canRequest||(!summary.eligible&&!input.overridePositive)))throw new ProductError(summary.reason,409,"GUARANTEE_REVIEW_REQUIRED");
    const note=(input.status==="approved"&&input.overridePositive?"【運営者が実返信を確認し、自動判定を訂正】\n":"")+input.note;
    const [saved]=await tx.update(higuchiRefundRequests).set({status:input.status,note:note.slice(0,2000),reviewedBy:input.reviewedBy,updatedAt:new Date()}).where(and(eq(higuchiRefundRequests.id,input.id),eq(higuchiRefundRequests.organizationId,input.organizationId))).returning();
    recordActivity(state,input.status==="approved"?"返金保証の申請を確認しました。運営者がStripeで返金を実行します。":input.status==="rejected"?"返金保証の確認結果を更新しました。":"返金保証の申請を確認中です。","info");return saved;
  }).then(result=>result.result));
}
