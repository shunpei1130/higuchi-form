import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { gridProviderCredentials, gridProviders } from "@/lib/grid/schema";
import { decryptIntegrationCredentials, encryptIntegrationCredentials } from "@/lib/integrations/credentials";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { HiguchiIntegrationError } from "./integrationError";
import { buildGoogleMail, emailFromHeader, GOOGLE_MAIL_CALLBACK, GOOGLE_MAIL_SCOPES, GOOGLE_MAIL_SENDER, googleMailMessageId, signMailState, verifyMailState } from "./mail/contract";
import { extractGoogleMailThread, type GoogleMailThread, type GoogleMailInbound } from "./mail/thread";

export { GOOGLE_MAIL_CALLBACK, GOOGLE_MAIL_SCOPES, GOOGLE_MAIL_SENDER } from "./mail/contract";
const KEY = "higuchi-google-mail", PENDING = "higuchi-google-mail-pending";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
type Credentials = {refreshToken:string;emailAddress:string;scope:string;connectedAt:string};
type Json = Record<string,unknown>;
const object = (value:unknown):Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const cache = new Map<string,{token:string;expiresAt:number;connectedAt:string}>();
export class GoogleMailRefusedError extends HiguchiIntegrationError {
  readonly uncertain=false;
  constructor(message:string,readonly retryable=true){super(message);this.name="GoogleMailRefusedError";}
}
class GoogleTokenError extends HiguchiIntegrationError { constructor(readonly reason:string){super("Googleメールの認証に失敗しました。アカウントを再接続してください。",409);} }
function liveOnly():void { if (process.env.HIGUCHI_MODE === "simulation") throw new HiguchiIntegrationError("検証モードではGoogleメールに接続しません。",409); }
function client():{id:string;secret:string} {
  liveOnly();
  if (!process.env.GOOGLE_MAIL_CLIENT_ID || !process.env.GOOGLE_MAIL_CLIENT_SECRET) throw new HiguchiIntegrationError("GoogleメールのOAuthクライアントが未設定です。",409);
  return {id:process.env.GOOGLE_MAIL_CLIENT_ID,secret:process.env.GOOGLE_MAIL_CLIENT_SECRET};
}
async function load(organizationId:string,key=KEY):Promise<Record<string,string>|null> {
  return runInOrganization(organizationId,async()=>{
    const [row]=await db.select({enabled:gridProviders.enabled,payload:gridProviderCredentials.encryptedPayload}).from(gridProviders).leftJoin(gridProviderCredentials,eq(gridProviderCredentials.providerId,gridProviders.id)).where(and(inOrg(gridProviders),eq(gridProviders.key,key))).limit(1);
    return row?.enabled && row.payload ? decryptIntegrationCredentials(row.payload) : null;
  });
}
async function save(organizationId:string,key:string,value:Record<string,string>):Promise<void> {
  await runInOrganization(organizationId,()=>db.transaction(async tx=>{
    const [provider]=await tx.insert(gridProviders).values({organizationId,key,name:key===KEY?"higuchi-form Google OAuth":"higuchi-form Google OAuth pending",enabled:true,config:{higuchiIntegration:key}}).onConflictDoUpdate({target:[gridProviders.organizationId,gridProviders.key],set:{enabled:true,updatedAt:new Date()}}).returning({id:gridProviders.id});
    await tx.insert(gridProviderCredentials).values({providerId:provider.id,encryptedPayload:encryptIntegrationCredentials(value)}).onConflictDoUpdate({target:gridProviderCredentials.providerId,set:{encryptedPayload:encryptIntegrationCredentials(value),updatedAt:new Date()}});
  }));
}
export type GoogleMailStatus = {connected:boolean;configured:boolean;emailAddress:string|null;status:"ready"|"unconfigured";detail:string;callbackUrl:string};
export async function getGoogleMailStatus(organizationId:string):Promise<GoogleMailStatus> {
  const configured=Boolean(process.env.GOOGLE_MAIL_CLIENT_ID&&process.env.GOOGLE_MAIL_CLIENT_SECRET);
  const stored=process.env.HIGUCHI_MODE==="simulation"?null:await load(organizationId);
  const connected=Boolean(configured&&stored?.refreshToken&&stored.emailAddress===GOOGLE_MAIL_SENDER);
  return {connected,configured,emailAddress:connected?GOOGLE_MAIL_SENDER:null,status:connected?"ready":"unconfigured",callbackUrl:GOOGLE_MAIL_CALLBACK,detail:connected?"Google OAuth接続済み。このアプリから開始した会話だけを同期します。":configured?`${GOOGLE_MAIL_SENDER} のGoogleアカウントを接続してください。`:"Google CloudのOAuthクライアント設定が必要です。"};
}
export async function beginGoogleMailAuthorization(input:{organizationId:string;userId:string;returnUrl?:string}):Promise<{url:string}> {
  const config=client(),nonce=randomBytes(32).toString("base64url"),verifier=randomBytes(48).toString("base64url");
  const state=signMailState({organizationId:input.organizationId,userId:input.userId,nonce,expiresAt:Date.now()+10*60_000},process.env.BETTER_AUTH_SECRET??"");
  await save(input.organizationId,PENDING,{stateHash:createHash("sha256").update(state).digest("hex"),verifier,userId:input.userId,expiresAt:String(Date.now()+10*60_000)});
  const url=new URL("https://accounts.google.com/o/oauth2/v2/auth");
  const params={client_id:config.id,redirect_uri:GOOGLE_MAIL_CALLBACK,response_type:"code",scope:GOOGLE_MAIL_SCOPES.join(" "),access_type:"offline",prompt:"consent",login_hint:GOOGLE_MAIL_SENDER,state,code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"};
  Object.entries(params).forEach(([key,value])=>url.searchParams.set(key,value));
  return {url:url.href};
}
async function tokenRequest(body:Record<string,string>):Promise<Json> {
  const response=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams(body),signal:AbortSignal.timeout(15_000),cache:"no-store"});
  const result=object(await response.json().catch(()=>null));
  if(!response.ok||typeof result.access_token!=="string")throw new GoogleTokenError(typeof result.error==="string"?result.error:"");
  return result;
}
async function revoke(token:string):Promise<void>{
  try{await fetch("https://oauth2.googleapis.com/revoke",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token}),signal:AbortSignal.timeout(15_000),cache:"no-store"});}catch{/* Local credentials are removed even when Google's revocation endpoint is unavailable. */}
}
async function request(token:string,path:string,init:RequestInit={},timeoutMs=15_000):Promise<Json> {
  const response=await fetch(`${API}${path}`,{...init,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",...init.headers},signal:AbortSignal.timeout(timeoutMs),cache:"no-store"});
  if(!response.ok){
    if(init.method==="POST"&&response.status>=400&&response.status<500)throw new GoogleMailRefusedError(`Googleが送信を受け付けませんでした（${response.status}）。`,[401,403,408,429].includes(response.status));
    throw new HiguchiIntegrationError(`Googleメールへの接続に失敗しました（${response.status}）。`,502);
  }
  // A Gmail thread can grow indefinitely. Refuse oversized bodies instead of
  // loading an unbounded conversation into a short-lived Function.
  const reader=response.body?.getReader();if(!reader)return {};
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>2_000_000){await reader.cancel();throw new HiguchiIntegrationError("Googleメールの会話が大きすぎるため、手動での確認が必要です。",409);}chunks.push(part.value);}
  return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
export async function completeGoogleMailAuthorization(input:{state:string;code:string;userId:string}):Promise<{organizationId:string;emailAddress:string}> {
  const config=client(),state=verifyMailState(input.state,input.userId,process.env.BETTER_AUTH_SECRET??"");
  const pending=await runInOrganization(state.organizationId,()=>db.transaction(async tx=>{
    const [row]=await tx.select({id:gridProviders.id,payload:gridProviderCredentials.encryptedPayload}).from(gridProviders).innerJoin(gridProviderCredentials,eq(gridProviderCredentials.providerId,gridProviders.id)).where(and(inOrg(gridProviders),eq(gridProviders.key,PENDING))).for("update").limit(1);
    const stored=row?decryptIntegrationCredentials(row.payload):null;
    if(!stored||stored.stateHash!==createHash("sha256").update(input.state).digest("hex")||stored.userId!==input.userId||Number(stored.expiresAt)<=Date.now())throw new HiguchiIntegrationError("メール接続が期限切れ、または使用済みです。接続をやり直してください。",409);
    await tx.delete(gridProviders).where(and(inOrg(gridProviders),eq(gridProviders.id,row.id)));
    return stored;
  }));
  const result=await tokenRequest({client_id:config.id,client_secret:config.secret,grant_type:"authorization_code",code:input.code,code_verifier:pending.verifier,redirect_uri:GOOGLE_MAIL_CALLBACK});
  const scope=typeof result.scope==="string"?result.scope:"";
  if(GOOGLE_MAIL_SCOPES.some(required=>!scope.split(" ").includes(required))||typeof result.refresh_token!=="string"){await revoke(String(result.access_token));throw new HiguchiIntegrationError("送信と読み取りの両方の権限を許可して、再接続してください。",409);}
  const profile=await request(String(result.access_token),"/profile");
  if(String(profile.emailAddress).toLowerCase()!==GOOGLE_MAIL_SENDER){await revoke(String(result.access_token));throw new HiguchiIntegrationError(`${GOOGLE_MAIL_SENDER} のGoogleアカウントを選択してください。別の送信元は接続できません。`,409);}
  await save(state.organizationId,KEY,{refreshToken:result.refresh_token,emailAddress:GOOGLE_MAIL_SENDER,scope,connectedAt:new Date().toISOString()});
  cache.delete(state.organizationId);
  return {organizationId:state.organizationId,emailAddress:GOOGLE_MAIL_SENDER};
}
export async function disconnectGoogleMail(organizationId:string):Promise<void> {
  liveOnly();
  const stored=await load(organizationId);
  await runInOrganization(organizationId,async()=>{await db.delete(gridProviders).where(and(inOrg(gridProviders),eq(gridProviders.key,KEY)));await db.delete(gridProviders).where(and(inOrg(gridProviders),eq(gridProviders.key,PENDING)));});
  cache.delete(organizationId);
  if(stored?.refreshToken)await revoke(stored.refreshToken);
}
async function accessToken(organizationId:string):Promise<string> {
  const config=client(),hit=cache.get(organizationId);
  const stored=await load(organizationId) as Credentials|null;
  if(!stored?.refreshToken||stored.emailAddress!==GOOGLE_MAIL_SENDER)throw new GoogleMailRefusedError("Googleメールの接続が必要です。");
  if(hit&&hit.expiresAt>Date.now()&&hit.connectedAt===stored.connectedAt)return hit.token;
  let result:Json;
  try{result=await tokenRequest({client_id:config.id,client_secret:config.secret,grant_type:"refresh_token",refresh_token:stored.refreshToken});}
  catch(error){if(error instanceof GoogleTokenError&&error.reason==="invalid_grant"){cache.delete(organizationId);await runInOrganization(organizationId,()=>db.update(gridProviders).set({enabled:false,updatedAt:new Date()}).where(and(inOrg(gridProviders),eq(gridProviders.key,KEY))));}throw error;}
  const token=String(result.access_token);cache.set(organizationId,{token,connectedAt:stored.connectedAt,expiresAt:Date.now()+Math.max(0,Math.min(Number(result.expires_in)||3600,3600)-60)*1000});
  if(typeof result.refresh_token==="string")await save(organizationId,KEY,{...stored,refreshToken:result.refresh_token});
  return token;
}
export async function sendGoogleMail(input:{organizationId:string;messageId:string;to:string;subject:string;body:string;threadId?:string;inReplyTo?:string;references?:string[];unsubscribeUrl?:string}):Promise<{providerMessageId:string;providerThreadId:string;acceptedAt:string;rfcMessageId:string}> {
  // Caller must hold its durable send claim. This function never retries POST.
  let built:ReturnType<typeof buildGoogleMail>,token:string;
  try{built=buildGoogleMail(input);token=await accessToken(input.organizationId);}
  catch(error){if(error instanceof GoogleMailRefusedError)throw error;throw new GoogleMailRefusedError(error instanceof Error?error.message:"送信前の認証を確認できませんでした。");}
  const result=await request(token,"/messages/send",{method:"POST",body:JSON.stringify({raw:built.raw,...(input.threadId?{threadId:input.threadId}:{})})});
  if(typeof result.id!=="string"||typeof result.threadId!=="string")throw new HiguchiIntegrationError("メール送信の受付結果を確認できません。自動再送せず結果を確認してください。",502);
  return {providerMessageId:result.id,providerThreadId:result.threadId,acceptedAt:new Date().toISOString(),rfcMessageId:built.rfcMessageId};
}
export async function reconcileGoogleMail(input:{organizationId:string;messageId:string}):Promise<{status:"sent"|"uncertain"|"missing";providerMessageId?:string;providerThreadId?:string;acceptedAt?:string}> {
  const token=await accessToken(input.organizationId),rfcId=googleMailMessageId(input.organizationId,input.messageId);
  const listing=await request(token,`/messages?maxResults=2&q=${encodeURIComponent(`in:sent rfc822msgid:${rfcId}`)}`);
  const found=Array.isArray(listing.messages)?listing.messages:[];
  if(found.length!==1)return {status:"uncertain"}; // Gmail indexing can lag; missing never authorizes a resend.
  const id=object(found[0]).id;if(typeof id!=="string")return {status:"uncertain"};
  const message=await request(token,`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=From`);
  const payload=object(message.payload),headers=Array.isArray(payload.headers)?payload.headers.map(object):[];
  const header=(name:string)=>String(headers.find(h=>String(h.name).toLowerCase()===name)?.value??"");
  const at=Number(message.internalDate);
  if(header("message-id")!==rfcId||emailFromHeader(header("from"))!==GOOGLE_MAIL_SENDER||!Array.isArray(message.labelIds)||!message.labelIds.includes("SENT")||!Number.isFinite(at))return {status:"uncertain"};
  return {status:"sent",providerMessageId:id,providerThreadId:typeof message.threadId==="string"?message.threadId:undefined,acceptedAt:new Date(at).toISOString()};
}
export type { GoogleMailThread, GoogleMailInbound } from "./mail/thread";
export async function syncGoogleMailThreads(input:{organizationId:string;threads:GoogleMailThread[];limit?:number;syncBudgetMs?:number}):Promise<GoogleMailInbound[]> {
  const token=await accessToken(input.organizationId),result:GoogleMailInbound[]=[];
  const started=Date.now(),budget=Math.min(20_000,Math.max(1000,input.syncBudgetMs??20_000)),limit=Math.min(100,Math.max(1,input.limit??20));
  // One thread per durable poll job; its caller rotates the cursor in Postgres.
  const threads=input.threads.slice(0,1);
  for(const known of threads){
    const remaining=budget-(Date.now()-started);if(remaining<1000)break;
    if(!/^[a-zA-Z0-9_-]{1,200}$/.test(known.providerThreadId))continue;
    const thread=await request(token,`/threads/${encodeURIComponent(known.providerThreadId)}?format=full`,{},Math.min(15_000,remaining));
    result.push(...extractGoogleMailThread(known,thread).slice(0,limit));
  }
  return result;
}
