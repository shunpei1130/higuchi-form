import type { BillingState,Conversation,Meeting } from "./types";
import type { OutboxItem } from "./state";
import { JPY_PRICE_VERSION } from "./money";
import { latestReplyText } from "./jobs/inboxRules";
export const REFUND_GUARANTEE_VERSION="first-prepay-1000-v1";
export type GuaranteeReceipt={messageId:string;acceptedAt:string;providerMessageId:string};
export type GuaranteeBookingEvidence={campaignId:string;leadId:string;bookedAt:string;status:string};
export type GuaranteeSummary={available:boolean;currency:"JPY"|"USD";refundAmountMinor:number;sentCount:number;requiredSends:1000;positiveReplies:number;qualifiedAt:string|null;eligible:boolean;canRequest:boolean;reason:string;version:string};
export function isPositiveGuaranteeReply(body:string):boolean{
  const original=latestReplyText(body).split(/\n.{0,200}書きました[:：]/i)[0];
  const negativeJapanese=/興味.{0,8}(?:ありません|ございません|ない|なく)|不要|お断り|(?:資料|見積|価格|料金|メール|案内|連絡).{0,20}(?:送らない|送信しない|必要.{0,3}(?:ない|ありません)|控え|止め|結構)|(?:打ち合わせ|打合せ|打合|面談|商談|ミーティング).{0,20}(?:できません|難し|結構)|連絡.{0,8}(?:停止|しない)/i;
  const negativeEnglish=/unsubscribe|\b(?:not|never|aren['’]t|isn['’]t|wasn['’]t|weren['’]t)\b.{0,25}\binterested\b|\bno\s+(?:thanks|interest|need)\b|\b(?:do\s*not|don't|dont)\b.{0,25}\b(?:send|contact|email|schedule|book)\b|\b(?:stop|avoid)\s+(?:sending|contacting|emailing)\b/i;
  if(negativeJapanese.test(original)||negativeEnglish.test(original))return false;
  return /興味(?:が|は)?(?:あり|ある)|詳しく(?:知|聞)|(?:資料|見積|価格|料金).{0,12}(?:送|教|知|お願)|(?:打ち合わせ|打合せ|打合|面談|商談|ミーティング).{0,20}(?:お願|希望|可能|しま|でき)|(?:担当|責任者).{0,12}(?:紹介|つな|繋)|\binterested\b|\bsend\b.{0,15}\b(?:pricing|quote|details)\b|\b(?:book|schedule)\b.{0,15}\b(?:call|meeting)\b/i.test(original);
}
/** Uses confirmed paid sends, not drafts, retries, or the UI's mutable sent counter. */
export function evaluateRefundGuarantee(input:{billing:BillingState;outbox:OutboxItem[];conversations:Conversation[];meetings?:Meeting[];bookingEvidence?:GuaranteeBookingEvidence[];receipts:GuaranteeReceipt[];now?:Date}):GuaranteeSummary{
  const purchase=input.billing.firstPrepayment,base:GuaranteeSummary={available:false,currency:purchase?.currency??"JPY",refundAmountMinor:purchase?.amountMinor??0,sentCount:0,requiredSends:1000,positiveReplies:0,qualifiedAt:null,eligible:false,canRequest:false,reason:"円建ての初回前払い後にご利用いただけます。",version:REFUND_GUARANTEE_VERSION};
  if(!purchase||purchase.currency!=="JPY"||purchase.priceVersion!==JPY_PRICE_VERSION)return base;
  const bought=Date.parse(purchase.purchasedAt);if(!Number.isFinite(bought)||!Number.isSafeInteger(purchase.amountMinor)||purchase.amountMinor<=0)return base;
  const outbox=new Map(input.outbox.filter(out=>out.kind!=="reply"&&out.status==="sent"&&out.reservationCents>0).map(out=>[out.id,out]));
  const seenMessages=new Set<string>(),seenProviderIds=new Set<string>();
  const cohort=input.receipts.filter(receipt=>outbox.has(receipt.messageId)&&receipt.providerMessageId&&Date.parse(receipt.acceptedAt)>=bought).sort((a,b)=>Date.parse(a.acceptedAt)-Date.parse(b.acceptedAt)||a.messageId.localeCompare(b.messageId)).filter(receipt=>{if(seenMessages.has(receipt.messageId)||seenProviderIds.has(receipt.providerMessageId))return false;seenMessages.add(receipt.messageId);seenProviderIds.add(receipt.providerMessageId);return true;}).slice(0,1000);
  const qualifiedAt=cohort.length===1000?new Date(Date.parse(cohort[999].acceptedAt)+7*86400000).toISOString():null;
  const cutoff=qualifiedAt?Date.parse(qualifiedAt):(input.now??new Date()).getTime(),firstByLead=new Map<string,number>();
  for(const receipt of cohort){const out=outbox.get(receipt.messageId)!;const key=`${out.campaignId}:${out.leadId}`;firstByLead.set(key,Math.min(firstByLead.get(key)??Infinity,Date.parse(receipt.acceptedAt)));}
  const positiveLeads=new Set<string>();
  for(const thread of input.conversations){const key=`${thread.campaignId}:${thread.leadId}`,first=firstByLead.get(key);if(first===undefined)continue;if(thread.messages.some(message=>message.direction==="inbound"&&!message.automatic&&message.status==="received"&&Date.parse(message.sentAt)>=first&&Date.parse(message.sentAt)<=cutoff&&isPositiveGuaranteeReply(message.body)))positiveLeads.add(key);}
  // Meeting.startsAt is the appointment, not booking acceptance; only canonical timestamped evidence counts.
  for(const booking of input.bookingEvidence??[]){const key=`${booking.campaignId}:${booking.leadId}`,first=firstByLead.get(key),at=Date.parse(booking.bookedAt);if(first!==undefined&&booking.status==="booked"&&at>=first&&at<=cutoff)positiveLeads.add(key);}
  const positive=positiveLeads.size,ready=Boolean(qualifiedAt&&(input.now??new Date()).getTime()>=Date.parse(qualifiedAt));
  return {...base,available:true,sentCount:cohort.length,positiveReplies:positive,qualifiedAt,eligible:ready&&positive===0,canRequest:ready,reason:cohort.length<1000?`対象の確定送信は${cohort.length.toLocaleString("ja-JP")}／1,000通です。`:!ready?"1,000通目の送信から7日間、返信を確認します。":positive?"好意的な返信または商談予約が記録されています。判定内容の確認を申請できます。":"返金保証の申請条件を満たしています。"};
}
