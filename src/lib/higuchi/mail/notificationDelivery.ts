import { decryptNotification, notificationKey, NOTIFICATION_FROM, NOTIFICATION_REPLY_TO, renderNotification } from "./notificationsContract";

export class NotificationDeliveryError extends Error { constructor(message:string,readonly permanent=false){super(message);} }
/** Provider-only transport. The durable caller supplies an immutable event key. */
export async function deliverNotification(encryptedPayload:string,idempotencyKey:string,fetcher:typeof fetch=fetch,now=Date.now(),jobId?:string):Promise<{providerMessageId?:string;expired?:boolean}> {
  if(process.env.HIGUCHI_MODE==="simulation")throw new NotificationDeliveryError("検証モードでは通知メールを送信しません。",true);
  const envelope=decryptNotification(encryptedPayload);
  if(Date.parse(envelope.expiresAt)<=now)return {expired:true};
  const key=process.env.RESEND_API_KEY;if(!key)throw new NotificationDeliveryError("通知メール配信が未設定です。");
  const rendered=renderNotification(envelope);
  const response=await fetcher("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json","Idempotency-Key":notificationKey(idempotencyKey)},body:JSON.stringify({from:NOTIFICATION_FROM,reply_to:NOTIFICATION_REPLY_TO,to:[envelope.to],...rendered,...(jobId?{tags:[{name:"higuchi_job",value:jobId}]}:{})}),signal:AbortSignal.timeout(20_000)});
  if(!response.ok)throw new NotificationDeliveryError(`通知メールを受け付けられませんでした（${response.status}）。`,response.status>=400&&response.status<500&&response.status!==429);
  const result=await response.json() as {id?:unknown};
  if(typeof result.id!=="string")throw new NotificationDeliveryError("通知メールの受付結果を確認できませんでした。");
  return {providerMessageId:result.id};
}
