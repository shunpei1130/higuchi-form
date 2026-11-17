import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { enqueueJob, PermanentJobError, type JobsExecutor, type DurableJob } from "./jobs/store";
import { higuchiJobs } from "./jobs/schema";
import { encryptNotification, notificationEnvelope, notificationKey, verifyResendSignature, type NotificationInput } from "./mail/notificationsContract";
import { deliverNotification, NotificationDeliveryError } from "./mail/notificationDelivery";
export { deliverNotification } from "./mail/notificationDelivery";
export type { NotificationInput, NotificationKind } from "./mail/notificationsContract";

/** Await this inside the business transaction. Only encrypted bodies enter the durable queue. */
export async function enqueueNotification(executor:JobsExecutor|undefined,input:NotificationInput):Promise<string> {
  if(process.env.HIGUCHI_MODE==="simulation")throw new Error("検証モードでは通知メールを登録しません。");
  const envelope=notificationEnvelope(input);
  return enqueueJob({organizationId:input.organizationId??null,kind:"notification",idempotencyKey:notificationKey(input.idempotencyKey),payload:{encryptedPayload:encryptNotification(envelope)},maxAttempts:8},executor);
}
export async function processNotificationJob(job:Pick<DurableJob,"id"|"payload"|"idempotencyKey">):Promise<{providerMessageId?:string;expired?:boolean}> {
  if(typeof job.payload.providerMessageId==="string")return {providerMessageId:job.payload.providerMessageId};
  if(typeof job.payload.encryptedPayload!=="string")throw new PermanentJobError("通知メールの保存内容が正しくありません。");
  let result:{providerMessageId?:string;expired?:boolean};
  try{result=await deliverNotification(job.payload.encryptedPayload,job.idempotencyKey,fetch,Date.now(),job.id);}
  catch(error){if(error instanceof NotificationDeliveryError&&error.permanent)throw new PermanentJobError(error.message);throw error;}
  const receipt={...result,...(result.providerMessageId?{acceptedAt:new Date().toISOString()}:{})};
  await db.update(higuchiJobs).set({payload:sql`${higuchiJobs.payload} || ${JSON.stringify(receipt)}::jsonb`,updatedAt:new Date()}).where(and(eq(higuchiJobs.id,job.id),eq(higuchiJobs.kind,"notification")));
  return result;
}
/** Delivery events update only known application notification receipts; no receiving capability. */
export async function handleResendDeliveryWebhook(request:Request):Promise<void> {
  const secret=process.env.RESEND_WEBHOOK_SECRET;if(!secret)throw new Error("通知メールの署名設定がありません。");
  const raw=await request.text();if(Buffer.byteLength(raw)>256_000)throw new Error("通知が大きすぎます。");
  const verified=verifyResendSignature(raw,request.headers,secret),event=verified.event;
  const types=["email.sent","email.delivered","email.bounced","email.complained","email.failed","email.suppressed","email.delivery_delayed"];
  if(typeof event.type!=="string"||!types.includes(event.type))return;
  const data=event.data&&typeof event.data==="object"&&!Array.isArray(event.data)?event.data as Record<string,unknown>:{};
  if(typeof data.email_id!=="string"||data.email_id.length>200)return;
  const created=typeof event.created_at==="string"?Date.parse(event.created_at):NaN;if(!Number.isFinite(created))throw new Error("通知日時が正しくありません。");
  await db.transaction(async tx=>{
    const tags=data.tags&&typeof data.tags==="object"?data.tags as Record<string,unknown>|Array<{name?:string;value?:string}>:{};
    const taggedId=Array.isArray(tags)?tags.find(tag=>tag.name==="higuchi_job")?.value:tags.higuchi_job;
    const validId=typeof taggedId==="string"&&/^[0-9a-f-]{36}$/i.test(taggedId)?taggedId:null;
    const [job]=await tx.select().from(higuchiJobs).where(and(eq(higuchiJobs.kind,"notification"),validId?eq(higuchiJobs.id,validId):sql`${higuchiJobs.payload}->>'providerMessageId' = ${data.email_id}`)).for("update").limit(1);
    if(!job)return;
    if(typeof job.payload.providerMessageId==="string"&&job.payload.providerMessageId!==data.email_id)return;
    const current=job.payload.delivery&&typeof job.payload.delivery==="object"?job.payload.delivery as Record<string,unknown>:{};
    const severe=["email.bounced","email.complained","email.failed","email.suppressed"];
    if(current.eventId===verified.eventId||Number(current.timestamp??0)>created||(severe.includes(String(current.type))&&!severe.includes(event.type as string)))return;
    await tx.update(higuchiJobs).set({payload:{...job.payload,providerMessageId:data.email_id,delivery:{eventId:verified.eventId,type:event.type,timestamp:created}},updatedAt:new Date()}).where(eq(higuchiJobs.id,job.id));
  });
}
