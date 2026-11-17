import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { decryptCredentialText, encryptCredentialText } from "@/lib/integrations/credential-crypto";
import { singleEmail } from "./contract";

export const NOTIFICATION_FROM = "higuchi-form <noreply@kodama.maora.co.jp>";
export const NOTIFICATION_REPLY_TO = "s.hasegawa1130@gmail.com";
export type NotificationKind = "auth"|"booking.confirmed"|"booking.rescheduled"|"booking.cancelled"|"campaign"|"reply"|"billing"|"system";
export type NotificationInput = {organizationId?:string|null;to:string;kind:NotificationKind;data:Record<string,unknown>;idempotencyKey:string};
export type NotificationEnvelope = {to:string;kind:NotificationKind;data:Record<string,unknown>;createdAt:string;expiresAt:string};
const KINDS:NotificationKind[]=["auth","booking.confirmed","booking.rescheduled","booking.cancelled","campaign","reply","billing","system"];
export const notificationKey = (key:string) => `notice-${createHash("sha256").update(key).digest("hex")}`;
const text=(value:unknown,limit=4000)=>typeof value==="string"?value.slice(0,limit):"";
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
function appLink(value:unknown):string {
  if(typeof value!=="string"||value.length>3000)return "";
  try{const url=new URL(value),configured=new URL(process.env.BETTER_AUTH_URL||process.env.NEXT_PUBLIC_APP_URL||"https://form-higuchi.vercel.app");return url.origin===configured.origin&&(url.protocol==="https:"||(process.env.NODE_ENV!=="production"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname)))?url.href:"";}catch{return "";}
}
export function notificationEnvelope(input:NotificationInput,now=new Date()):NotificationEnvelope {
  if(!KINDS.includes(input.kind)||!input.idempotencyKey||input.idempotencyKey.length>1000||!input.data||typeof input.data!=="object"||Array.isArray(input.data))throw new Error("通知の内容が正しくありません。");
  if(JSON.stringify(input.data).length>150_000)throw new Error("通知の内容が大きすぎます。");
  return {to:singleEmail(input.to),kind:input.kind,data:input.data,createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+(input.kind==="auth"?5*60_000:23*60*60_000)).toISOString()};
}
export function encryptNotification(value:NotificationEnvelope):string{return encryptCredentialText(JSON.stringify(value));}
export function decryptNotification(payload:string):NotificationEnvelope {
  const value=JSON.parse(decryptCredentialText(payload)) as NotificationEnvelope;
  if(!value||!KINDS.includes(value.kind)||typeof value.to!=="string"||!value.data||typeof value.data!=="object"||!Number.isFinite(Date.parse(value.expiresAt)))throw new Error("保存された通知の形式が正しくありません。");
  singleEmail(value.to);return value;
}
export function renderNotification(value:NotificationEnvelope):{subject:string;text:string;html:string} {
  const data=value.data;
  if(value.kind==="auth"){
    const subject=text(data.subject,300),plain=text(data.text,60_000),html=text(data.html,100_000);
    if(!subject||!plain||!html||/[\r\n]/.test(subject))throw new Error("認証通知の内容が正しくありません。");
    return {subject,text:plain,html};
  }
  let subject=text(data.subject,300),body=text(data.text,20_000);
  if(value.kind.startsWith("booking.")){
    const action=value.kind==="booking.cancelled"?"予約がキャンセルされました":value.kind==="booking.rescheduled"?"予約日時が変更されました":"予約が確定しました";
    subject=`higuchi-form: ${action}`;
    const timezone=text(data.timezone,80)||"Asia/Tokyo";
    const format=(v:unknown)=>{const at=new Date(text(v,100));if(!Number.isFinite(at.getTime()))return "未設定";try{return new Intl.DateTimeFormat("ja-JP",{timeZone:timezone,dateStyle:"full",timeStyle:"short"}).format(at);}catch{return at.toISOString();}};
    const manage=appLink(data.manageUrl);
    body=[action,`予定: ${text(data.eventTitle,300)||"オンライン相談"}`,`開始: ${format(data.startsAt)}`,`終了: ${format(data.endsAt)}`,`タイムゾーン: ${timezone}`,data.hostName?`担当者: ${text(data.hostName,200)}`:"",data.guestName?`参加者: ${text(data.guestName,200)}`:"",data.locationUrl?`場所: ${text(data.locationUrl,2000)}`:data.locationText?`場所: ${text(data.locationText,2000)}`:"",manage?`予約の確認・変更: ${manage}`:""].filter(Boolean).join("\n");
  }
  if(!subject)subject="higuchi-formからのお知らせ";
  if(!body)throw new Error("通知の本文がありません。");
  if(/[\r\n]/.test(subject))throw new Error("通知の件名が正しくありません。");
  return {subject,text:body,html:`<!doctype html><html lang="ja"><head><title>${escape(subject)}</title></head><body style="font-family:Arial,sans-serif;color:#19231f;line-height:1.7"><h1 style="font-size:20px">${escape(subject)}</h1><p style="white-space:pre-line">${escape(body)}</p><p>higuchi-form</p></body></html>`};
}
export function verifyResendSignature(raw:string,headers:Headers,secret:string,now=Date.now()):{eventId:string;event:Record<string,unknown>} {
  const eventId=headers.get("svix-id")??"",timestamp=headers.get("svix-timestamp")??"",signature=headers.get("svix-signature")??"";
  if(!secret.startsWith("whsec_")||!eventId||eventId.length>200||!/^\d{9,12}$/.test(timestamp)||Math.abs(now-Number(timestamp)*1000)>5*60_000||signature.length>2000)throw new Error("通知の署名を確認できませんでした。");
  const expected=createHmac("sha256",Buffer.from(secret.slice(6),"base64")).update(`${eventId}.${timestamp}.${raw}`).digest();
  const valid=signature.split(" ").some(item=>{const [version,value]=item.split(",");if(version!=="v1"||!value)return false;const actual=Buffer.from(value,"base64");return actual.length===expected.length&&timingSafeEqual(actual,expected);});
  if(!valid)throw new Error("通知の署名を確認できませんでした。");
  const parsed:unknown=JSON.parse(raw);if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Error("通知の形式が正しくありません。");
  return {eventId,event:parsed as Record<string,unknown>};
}
