import { expect, test } from "bun:test";
import { createWorkspace, type OutboxItem } from "./state";
import { JPY_PRICE_VERSION } from "./money";
import type { Conversation, InboxMessage } from "./types";
import { evaluateRefundGuarantee, isPositiveGuaranteeReply, type GuaranteeReceipt } from "./guaranteePolicy";

function fixture(count=1000){
  const state=createWorkspace("live","2026-11-17T00:00:00.000Z","JPY");
  state.billing.firstPrepayment={sessionId:"cs_first",paymentIntentId:"pi_first",chargeId:"ch_first",currency:"JPY",priceVersion:JPY_PRICE_VERSION,amountMinor:4500,purchasedAt:"2026-11-01T00:00:00.000Z"};
  const outbox:OutboxItem[]=Array.from({length:count},(_,i)=>({id:`message-${i}`,projectId:"p",campaignId:"campaign-a",leadId:`lead-${i}`,conversationId:null,subject:"件名",body:"本文",kind:"initial",status:"sent",createdAt:"2026-11-02T00:00:00.000Z",reservationCents:6}));
  const receipts:GuaranteeReceipt[]=outbox.map((out,i)=>({messageId:out.id,acceptedAt:new Date(Date.parse("2026-11-02T00:00:00Z")+i*1000).toISOString(),providerMessageId:`gmail-${i}`}));
  return {billing:state.billing,outbox,receipts,conversations:[] as Conversation[],now:new Date("2026-11-17T00:00:00Z")};
}
function thread(messages:Partial<InboxMessage>[],leadId="lead-0",campaignId="campaign-a"):Conversation{return {id:"t",projectId:"p",campaignId,leadId,subject:"件名",unread:false,status:"active",autoReplyAt:null,pendingReply:null,notes:"",messages:messages.map((m,i)=>({id:`inbound-${i}`,direction:"inbound",body:"興味があります。",sentAt:"2026-11-03T00:00:00Z",automatic:false,status:"received",...m}))};}

test("guarantee matures from 1,000 accepted paid sends, never a mutable UI counter",()=>{
  expect(evaluateRefundGuarantee(fixture(999))).toMatchObject({sentCount:999,eligible:false,canRequest:false});
  const ready=evaluateRefundGuarantee(fixture());expect(ready).toMatchObject({sentCount:1000,eligible:true,canRequest:true,refundAmountMinor:4500});expect(ready.qualifiedAt).toBe("2026-11-09T00:16:39.000Z");
  const early=fixture();early.now=new Date("2026-11-08T23:00:00Z");expect(evaluateRefundGuarantee(early).canRequest).toBe(false);
});
test("free replies, nonaccepted states, pre-purchase sends and duplicate provider receipts do not count",()=>{
  const input=fixture(1005);input.outbox[0].kind="reply";input.outbox[1].reservationCents=0;input.outbox[2].status="uncertain";input.receipts[3].acceptedAt="2026-10-01T00:00:00Z";input.receipts[4].providerMessageId=input.receipts[5].providerMessageId;input.receipts.push({...input.receipts[6]});
  expect(evaluateRefundGuarantee(input).sentCount).toBe(1000);input.outbox[7].status="cancelled";expect(evaluateRefundGuarantee(input).sentCount).toBe(999);
});
test("only first-cohort human replies in the evaluation window affect eligibility",()=>{
  const input=fixture(1001);input.conversations=[thread([{}],"lead-1000"),thread([{automatic:true}]),thread([{sentAt:"2026-11-01T00:00:00Z"}]),thread([{sentAt:"2026-11-10T00:00:00Z"}])];
  expect(evaluateRefundGuarantee(input)).toMatchObject({positiveReplies:0,eligible:true,canRequest:true});input.conversations.push(thread([{}]),thread([{}]));
  const result=evaluateRefundGuarantee(input);expect(result).toMatchObject({positiveReplies:1,eligible:false,canRequest:true});expect(result.reason).toContain("判定内容の確認を申請できます");
});
test("negative statements and quoted history are never positive interest",()=>{
  for(const body of ["資料は送らないでください。","資料の送付は結構です。","打ち合わせはできません。","今後のメールは不要です。","興味はございません。","I am not really interested.","We aren't interested.","No need to send details.","Please don't schedule a meeting.","Please don't send pricing or details.","> 興味があります。","不要です。\nOn Tue Someone wrote:\n興味があります。","確認しました。\n> 興味があります。"]){expect(isPositiveGuaranteeReply(body)).toBe(false);}
  for(const body of ["興味があります。詳しく聞きたいです。","資料を送ってください。","Please send pricing details.","Let's schedule a meeting."]){expect(isPositiveGuaranteeReply(body)).toBe(true);}
});
test("automatic and simulated inbound never affect refund eligibility",()=>{
  const input=fixture();input.conversations=[thread([{automatic:true,body:"興味があります。休暇中の自動返信です。"},{status:"simulated"}])];expect(evaluateRefundGuarantee(input).positiveReplies).toBe(0);
});
test("booking evidence uses canonical acceptance time, cohort and state, not appointment time",()=>{
  const input=fixture(),bookings=[{campaignId:"campaign-a",leadId:"lead-0",bookedAt:"2026-11-03T00:00:00Z",status:"booked"}];
  expect(evaluateRefundGuarantee({...input,bookingEvidence:bookings})).toMatchObject({positiveReplies:1,eligible:false,canRequest:true});
  for(const patch of [{bookedAt:"2026-10-31T00:00:00Z"},{bookedAt:"2026-11-10T00:00:00Z"},{status:"cancelled"},{campaignId:"other-campaign"},{leadId:"not-in-cohort"},{bookedAt:"invalid"}])expect(evaluateRefundGuarantee({...input,bookingEvidence:[{...bookings[0],...patch}]}).positiveReplies).toBe(0);
  expect(evaluateRefundGuarantee({...input,meetings:[{id:"old-view",projectId:"p",campaignId:"campaign-a",leadId:"lead-0",startsAt:"2026-11-03T00:00:00Z",status:"booked",provider:"internal"}]}).positiveReplies).toBe(0);
});
test("legacy USD and invalid purchase evidence never become a JPY guarantee",()=>{
  const input=fixture();input.billing.firstPrepayment!.currency="USD";expect(evaluateRefundGuarantee(input).available).toBe(false);input.billing.firstPrepayment!.currency="JPY";input.billing.firstPrepayment!.purchasedAt="invalid";expect(evaluateRefundGuarantee(input).available).toBe(false);
});
