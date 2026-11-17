import "server-only";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { higuchiMailReceipts } from "./jobs/schema";
import { higuchiWorkspaces } from "./schema";
import { getHiguchiMode } from "./mode";
import { HiguchiIntegrationError } from "./integrationError";
import { getGoogleMailStatus, sendGoogleMail, reconcileGoogleMail, syncGoogleMailThreads } from "./googleMail";
import type { WorkspaceState } from "./state";
import { googleMailMessageId } from "./mail/contract";

export type SendOutreachInput={organizationId:string;projectId:string;campaignId:string;messageId:string;lead:{email:string;name:string;company:string;role?:string;website?:string};subject:string;body:string;mailboxId?:string;replyToMessageId?:string;providerThreadId?:string;stepNumber?:number};
export type SendOutreachResult={providerMessageId:string;providerThreadId?:string;acceptedAt:string;mailboxId?:string;upstreamCampaignId?:string};
export type OutreachDeliveryReceipt={status:"sent"|"uncertain"|"missing";providerMessageId?:string;providerThreadId?:string;acceptedAt?:string};
export class HiguchiSendRefusedError extends HiguchiIntegrationError {readonly uncertain=false;constructor(message:string,readonly retryable=true){super(message);this.name="HiguchiSendRefusedError";}}
export function providerRowId(organizationId:string,value:string){const h=createHash("sha256").update(`${organizationId}:${value}`).digest("hex");return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
export async function assignProviderMailbox(_input:{organizationId:string;emailAddress:string;displayName?:string;dailySendLimit?:number}):Promise<{mailboxId:string}>{throw new HiguchiIntegrationError("運営者設定のGoogleメール接続から本人認証を行ってください。");}
export async function listProviderMailboxes(organizationId:string){const status=await getGoogleMailStatus(organizationId);return status.connected?[{id:organizationId,emailAddress:status.emailAddress!,displayName:"MAORA株式会社",status:"connected",dailySendLimit:30}]:[];}
function japaneseDay(date=new Date()){return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit"}).format(date);}
function withinHours(){const parts=new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Tokyo",weekday:"short",hour:"numeric",hourCycle:"h23"}).formatToParts(new Date());const day=parts.find(p=>p.type==="weekday")?.value;const hour=Number(parts.find(p=>p.type==="hour")?.value);return !["Sat","Sun"].includes(day??"")&&hour>=10&&hour<18;}
export async function lookupOutreachDelivery(input:{organizationId:string;messageId:string}):Promise<OutreachDeliveryReceipt>{
  const [row]=await db.select().from(higuchiMailReceipts).where(and(eq(higuchiMailReceipts.organizationId,input.organizationId),eq(higuchiMailReceipts.messageId,input.messageId))).limit(1);
  if(!row)return {status:"missing"};
  if(row.status==="sent"&&row.providerMessageId&&row.acceptedAt)return {status:"sent",providerMessageId:row.providerMessageId,providerThreadId:row.providerThreadId??undefined,acceptedAt:row.acceptedAt.toISOString()};
  if(row.status==="failed")return {status:"missing"};
  const receipt=await reconcileGoogleMail(input);
  if(receipt.status==="sent"&&receipt.providerMessageId&&receipt.acceptedAt){await db.update(higuchiMailReceipts).set({status:"sent",providerMessageId:receipt.providerMessageId,providerThreadId:receipt.providerThreadId,acceptedAt:new Date(receipt.acceptedAt)}).where(and(eq(higuchiMailReceipts.id,row.id),eq(higuchiMailReceipts.organizationId,input.organizationId)));}
  return receipt;
}
export async function sendOutreach(input:SendOutreachInput):Promise<SendOutreachResult>{
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.lead.email)||/[\r\n]/.test(input.subject)||!input.body.trim())throw new HiguchiSendRefusedError("送信先と文面を確認してください。",false);
  if(getHiguchiMode()==="simulation")return {providerMessageId:`simulation_${input.messageId}`,providerThreadId:`simulation_${input.campaignId}_${input.lead.email}`,acceptedAt:new Date().toISOString()};
  if(process.env.VERCEL_ENV&&process.env.VERCEL_ENV!=="production"||process.env.HIGUCHI_SEND_ENABLED!=="true")throw new HiguchiSendRefusedError("実メール送信は現在停止しています。");
  const status=await getGoogleMailStatus(input.organizationId);if(!status.connected)throw new HiguchiSendRefusedError(status.detail);
  const hash=createHash("sha256").update(JSON.stringify([input.lead.email,input.subject,input.body])).digest("hex");
  const claim=await db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`higuchi-mail:${status.emailAddress}`},0))`);
    const [old]=await tx.select().from(higuchiMailReceipts).where(and(eq(higuchiMailReceipts.organizationId,input.organizationId),eq(higuchiMailReceipts.messageId,input.messageId))).for("update");
    if(old&&old.contentHash!==hash)throw new HiguchiSendRefusedError("同じ送信IDの文面を変更できません。",false);
    if(old&&old.status!=="failed")return {existing:true};
    if(!withinHours())throw new HiguchiSendRefusedError("送信時間は日本時間の平日10〜18時です。");
    // This deployment has one fixed authorized sender; its daily cap spans all customers.
    const day=japaneseDay();const [count]=await tx.select({total:sql<number>`count(*)::int`}).from(higuchiMailReceipts).where(sql`${higuchiMailReceipts.status} in ('pending','uncertain','sent') and (${higuchiMailReceipts.createdAt} at time zone 'Asia/Tokyo')::date=${day}::date`);
    if(Number(count?.total??0)>=30)throw new HiguchiSendRefusedError("本日の送信上限30通に達しました。");
    if(old)await tx.update(higuchiMailReceipts).set({status:"pending",createdAt:new Date()}).where(eq(higuchiMailReceipts.id,old.id));
    else await tx.insert(higuchiMailReceipts).values({organizationId:input.organizationId,messageId:input.messageId,toEmail:input.lead.email,contentHash:hash});
    return {existing:false};
  });
  if(claim.existing){const receipt=await lookupOutreachDelivery(input);if(receipt.status==="sent"&&receipt.providerMessageId&&receipt.acceptedAt)return {providerMessageId:receipt.providerMessageId,providerThreadId:receipt.providerThreadId,acceptedAt:receipt.acceptedAt};throw new HiguchiIntegrationError("送信結果の照合が必要です。自動再送はしません。");}
  try{
    const {buildUnsubscribeToken}=await import("@/lib/outreach/unsubscribeToken");
    const token=buildUnsubscribeToken(input.lead.email,input.organizationId);
    const unsubscribeUrl=new URL(`/unsubscribe?token=${token}`,process.env.BETTER_AUTH_URL??"https://form-higuchi.vercel.app").href;
    const sent=await sendGoogleMail({organizationId:input.organizationId,messageId:input.messageId,to:input.lead.email,subject:input.subject,body:input.body,threadId:input.providerThreadId,inReplyTo:input.replyToMessageId,unsubscribeUrl});
    await db.update(higuchiMailReceipts).set({status:"sent",providerMessageId:sent.providerMessageId,providerThreadId:sent.providerThreadId,rfcMessageId:sent.rfcMessageId,acceptedAt:new Date(sent.acceptedAt)}).where(and(eq(higuchiMailReceipts.organizationId,input.organizationId),eq(higuchiMailReceipts.messageId,input.messageId)));
    return sent;
  }catch(error){const safe=(error as {uncertain?:boolean}).uncertain===false;await db.update(higuchiMailReceipts).set({status:safe?"failed":"uncertain"}).where(and(eq(higuchiMailReceipts.organizationId,input.organizationId),eq(higuchiMailReceipts.messageId,input.messageId)));throw error;}
}
export async function syncProviderInbox(organizationId:string){
  const [row]=await db.select({state:higuchiWorkspaces.state}).from(higuchiWorkspaces).where(eq(higuchiWorkspaces.organizationId,organizationId));
  const state=row?.state as WorkspaceState|undefined;if(!state)return [];
  const seenMessageIds=state.internal.providerEvents.filter(key=>key.startsWith("inbound:")).map(key=>key.slice("inbound:".length));
  const threads=state.conversations.filter(t=>t.providerThreadId).map(t=>({providerThreadId:t.providerThreadId!,leadEmail:state.leads.find(l=>l.id===t.leadId)?.email??"",campaignId:t.campaignId,messageIds:t.messages.filter(message=>message.direction==="outbound").map(message=>googleMailMessageId(organizationId,message.id)),seenMessageIds}));
  if(!threads.length)return [];
  const index=Math.floor(Date.now()/60000)%threads.length;
  return syncGoogleMailThreads({organizationId,threads:[threads[index]],limit:20,syncBudgetMs:20000});
}
