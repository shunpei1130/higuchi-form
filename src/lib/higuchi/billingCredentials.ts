import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { gridProviderCredentials, gridProviders } from "@/lib/grid/schema";
import { decryptIntegrationCredentials, encryptIntegrationCredentials } from "@/lib/integrations/credentials";
import { currentOrganizationId, inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { HiguchiIntegrationError } from "./integrationError";
import { billingPolicy, formatMoney, type MoneyCurrency } from "./money";

export const BILLING_CONNECTION_KEY = "higuchi-billing";
export const JPY_BILLING_CONNECTION_KEY = "higuchi-billing-jpy-v1";
const connectionKey=(currency?:MoneyCurrency)=>currency==="JPY"?JPY_BILLING_CONNECTION_KEY:BILLING_CONNECTION_KEY;
/** Shared merchant credentials are deployment secrets; each customer mapping remains tenant-owned. */
export type BillingCredentials = {
  currency?:MoneyCurrency;priceVersion?:string;
  stripeSecretKey:string;stripePublishableKey:string;stripeWebhookSecret:string;stripeAccountId:string;
  stripeProductId:string;stripeMeterId:string;stripePriceId:string;stripeEventName:string;
  stripeCustomerId:string;stripeSubscriptionId:string;livemode:boolean;
};
export type BillingConnection = Pick<BillingCredentials,"stripeCustomerId"|"stripeSubscriptionId">;
const CONNECTION_FIELDS = ["stripeCustomerId","stripeSubscriptionId"] as const;
const emptyConnection = ():BillingConnection=>({stripeCustomerId:"",stripeSubscriptionId:""});

export function platformBillingCredentials(env:Record<string,string|undefined>=process.env,currency:MoneyCurrency=env.HIGUCHI_BILLING_CURRENCY==="JPY"?"JPY":"USD"):BillingCredentials {
  const stripeSecretKey=env.STRIPE_SECRET_KEY?.trim()??"";
  const prefix=currency==="JPY"?"STRIPE_JPY_":"STRIPE_";
  return {currency,priceVersion:billingPolicy(currency).priceVersion,stripeSecretKey,stripePublishableKey:env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim()||env.STRIPE_PUBLISHABLE_KEY?.trim()||"",stripeWebhookSecret:env.STRIPE_WEBHOOK_SECRET?.trim()??"",
    stripeAccountId:env.STRIPE_ACCOUNT_ID?.trim()??"",stripeProductId:env[`${prefix}PRODUCT_ID`]?.trim()??"",stripeMeterId:env[`${prefix}METER_ID`]?.trim()??"",
    stripePriceId:env[`${prefix}PRICE_ID`]?.trim()??"",stripeEventName:env[`${prefix}METER_EVENT_NAME`]?.trim()||(currency==="JPY"?"higuchi_email_sent_jpy_v1":"higuchi_email_sent_v1"),
    ...emptyConnection(),livemode:/^(?:rk|sk)_live_/.test(stripeSecretKey)};
}
export function assertPlatformBillingConfigured(credentials:BillingCredentials,{catalog=true,webhook=true}:{catalog?:boolean;webhook?:boolean}={}):void {
  if(!/^(?:rk|sk)_(?:test|live)_/.test(credentials.stripeSecretKey)||!/^acct_/.test(credentials.stripeAccountId))throw new HiguchiIntegrationError("Stripeの運営用接続が未設定です。");
  if(webhook&&!credentials.stripeWebhookSecret)throw new HiguchiIntegrationError("Stripeの通知署名が未設定です。");
  if(catalog&&(!/^prod_/.test(credentials.stripeProductId)||!/^mtr_/.test(credentials.stripeMeterId)||!/^price_/.test(credentials.stripePriceId)))throw new HiguchiIntegrationError("higuchi-form専用のStripe料金設定が未設定です。");
  if(credentials.stripePublishableKey&&credentials.stripePublishableKey.includes("_live_")!==credentials.livemode)throw new HiguchiIntegrationError("Stripeのテスト用と本番用の接続情報が一致していません。");
}
export async function getBillingCredentials(organizationId=currentOrganizationId(),currency?:MoneyCurrency):Promise<BillingCredentials|null> {
  const platform=platformBillingCredentials(process.env,currency);
  return runInOrganization(organizationId,async()=>{
    const [row]=await db.select({config:gridProviders.config,encryptedPayload:gridProviderCredentials.encryptedPayload,enabled:gridProviders.enabled}).from(gridProviders)
      .leftJoin(gridProviderCredentials,eq(gridProviderCredentials.providerId,gridProviders.id)).where(and(inOrg(gridProviders),eq(gridProviders.key,connectionKey(platform.currency)))).limit(1);
    if(!row?.enabled||!row.encryptedPayload)return {...platform,...emptyConnection()};
    const config=row.config as {version?:number;stripeAccountId?:string;stripeLivemode?:boolean;stripeCustomerId?:string;stripeSubscriptionId?:string};
    if(config.version!==2||!config.stripeAccountId||config.stripeLivemode===undefined)throw new HiguchiIntegrationError("以前の決済接続です。運営者がStripe顧客との対応を照合して再接続してください。");
    if(config.stripeAccountId&&config.stripeAccountId!==platform.stripeAccountId)throw new HiguchiIntegrationError("決済アカウントの対応が一致しません。運営者による照合が必要です。");
    if(config.stripeLivemode!==undefined&&config.stripeLivemode!==platform.livemode)throw new HiguchiIntegrationError("この組織の決済接続は別の環境用です。");
    const decoded=decryptIntegrationCredentials(row.encryptedPayload);
    if((decoded.stripeCustomerId??"")!==(config.stripeCustomerId??"")||(decoded.stripeSubscriptionId??"")!==(config.stripeSubscriptionId??""))throw new HiguchiIntegrationError("決済の対応情報に差異があります。運営者による照合が必要です。");
    return {...platform,stripeCustomerId:decoded.stripeCustomerId??"",stripeSubscriptionId:decoded.stripeSubscriptionId??""};
  });
}
export async function requireBillingCredentials(organizationId:string,currency?:MoneyCurrency):Promise<BillingCredentials> {
  const credentials=await getBillingCredentials(organizationId,currency);
  if(!credentials)throw new HiguchiIntegrationError("Stripeの接続が未設定です。");
  assertPlatformBillingConfigured(credentials);
  return credentials;
}

/** Only non-secret customer/subscription mappings are accepted; platform keys never travel through a member-facing form. */
async function persistBillingConnection(organizationId:string,input:Record<string,unknown>,options:{verifiedByAdapter?:boolean;currency?:MoneyCurrency}={}):Promise<void> {
  if(Object.keys(input).some(key=>!CONNECTION_FIELDS.includes(key as typeof CONNECTION_FIELDS[number])))throw new HiguchiIntegrationError("Stripeの運営用キーはデプロイ先のシークレットに設定してください。組織には顧客・契約の対応だけを保存します。");
  const platform=platformBillingCredentials(process.env,options.currency),key=connectionKey(platform.currency);
  assertPlatformBillingConfigured(platform,{catalog:false,webhook:false});
  // An operator may paste only app-owned identities. Syntax alone must never attach this app to an existing EC customer.
  const inputCustomer=typeof input.stripeCustomerId==="string"?input.stripeCustomerId.trim():"";
  const inputSubscription=typeof input.stripeSubscriptionId==="string"?input.stripeSubscriptionId.trim():"";
  let verifiedSubscriptionCustomer="";
  if(inputCustomer&&!/^cus_[a-zA-Z0-9]+$/.test(inputCustomer)||inputSubscription&&!/^sub_[a-zA-Z0-9]+$/.test(inputSubscription))throw new HiguchiIntegrationError("決済の対応IDが正しくありません。");
  const remote=async(path:string):Promise<Record<string,unknown>>=>{const response=await fetch(`https://api.stripe.com/v1${path}`,{headers:{Authorization:`Bearer ${platform.stripeSecretKey}`,"Stripe-Version":"2026-10-28.endive"},cache:"no-store",signal:AbortSignal.timeout(25000)});if(!response.ok)throw new HiguchiIntegrationError("Stripeの対応IDを照合できませんでした。",502);return await response.json() as Record<string,unknown>;};
  const assertIdentity=(value:Record<string,unknown>):void=>{const marker=value.metadata as Record<string,unknown>|undefined;if(marker?.higuchi_app!=="higuchi-form"||marker.higuchi_organization!==organizationId||value.livemode!==platform.livemode)throw new HiguchiIntegrationError("この決済IDは、同じ組織・環境のhiguchi-form専用IDではありません。");};
  if(!options.verifiedByAdapter&&inputCustomer){const customer=await remote(`/customers/${encodeURIComponent(inputCustomer)}`);assertIdentity(customer);}
  if(!options.verifiedByAdapter&&inputSubscription){const subscription=await remote(`/subscriptions/${encodeURIComponent(inputSubscription)}`);assertIdentity(subscription);verifiedSubscriptionCustomer=typeof subscription.customer==="string"?subscription.customer:"";const items=(subscription.items as {data?:Array<{price?:{id?:string}}>})?.data;if(inputCustomer&&subscription.customer!==inputCustomer||items?.length!==1||items[0].price?.id!==platform.stripePriceId)throw new HiguchiIntegrationError("Stripeの専用料金・顧客と契約が一致しません。");}
  await runInOrganization(organizationId,()=>db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`higuchi-stripe-mapping:${platform.stripeAccountId}`},0))`);
    const [existing]=await tx.select({id:gridProviders.id,config:gridProviders.config,payload:gridProviderCredentials.encryptedPayload}).from(gridProviders)
      .leftJoin(gridProviderCredentials,eq(gridProviderCredentials.providerId,gridProviders.id)).where(and(inOrg(gridProviders),eq(gridProviders.key,key))).limit(1);
    const current=existing?.payload?decryptIntegrationCredentials(existing.payload):emptyConnection();
    const previousConfig=existing?.config as {stripeAccountId?:string;stripeLivemode?:boolean}|undefined;
    if(previousConfig?.stripeAccountId&&(previousConfig.stripeAccountId!==platform.stripeAccountId||previousConfig.stripeLivemode!==platform.livemode))throw new HiguchiIntegrationError("別の決済環境の対応は引き継げません。運営者による再接続が必要です。");
    const merged={...emptyConnection(),stripeCustomerId:current.stripeCustomerId??"",stripeSubscriptionId:current.stripeSubscriptionId??""};
    for(const field of CONNECTION_FIELDS){const value=input[field];if(value===undefined||value==="")continue;if(typeof value!=="string"||value.length>200)throw new Error("決済の対応IDが正しくありません。");merged[field]=value.trim();}
    if(merged.stripeCustomerId&&!/^cus_[a-zA-Z0-9]+$/.test(merged.stripeCustomerId))throw new Error("Stripe顧客IDが正しくありません。");
    if(merged.stripeSubscriptionId&&!/^sub_[a-zA-Z0-9]+$/.test(merged.stripeSubscriptionId))throw new Error("Stripe契約IDが正しくありません。");
    if(!options.verifiedByAdapter&&inputSubscription&&verifiedSubscriptionCustomer!==merged.stripeCustomerId)throw new HiguchiIntegrationError("Stripe契約の顧客と組織の対応が一致しません。");
    if(inputCustomer&&current.stripeCustomerId&&inputCustomer!==current.stripeCustomerId)throw new HiguchiIntegrationError("既存の決済顧客を変更する場合は、運営者による残高と契約の照合が必要です。");
    if(merged.stripeCustomerId){
      // Provider identities resolve their tenant before scope is opened; this deliberate global lookup prevents cross-tenant reuse.
      const reused=await tx.select({organizationId:gridProviders.organizationId}).from(gridProviders).where(and(inArray(gridProviders.key,[BILLING_CONNECTION_KEY,JPY_BILLING_CONNECTION_KEY]),sql`${gridProviders.config}->>'stripeCustomerId' = ${merged.stripeCustomerId}`,sql`(${gridProviders.organizationId} <> ${organizationId} OR ${gridProviders.key} <> ${key})`)).limit(1);
      if(reused.length)throw new HiguchiIntegrationError("このStripe顧客は別の組織に割り当てられています。");
    }
    const config={higuchiIntegration:"billing",version:2,currency:platform.currency,priceVersion:platform.priceVersion,stripeAccountId:platform.stripeAccountId,stripeLivemode:platform.livemode,...merged};
    const [provider]=await tx.insert(gridProviders).values({organizationId,key,name:`higuchi-form Stripe ${platform.currency}`,enabled:true,config})
      .onConflictDoUpdate({target:[gridProviders.organizationId,gridProviders.key],set:{config,enabled:true,updatedAt:new Date()}}).returning({id:gridProviders.id});
    const payload=encryptIntegrationCredentials(merged);
    await tx.insert(gridProviderCredentials).values({providerId:provider.id,encryptedPayload:payload}).onConflictDoUpdate({target:gridProviderCredentials.providerId,set:{encryptedPayload:payload,updatedAt:new Date()}});
  }));
}
export async function saveHiguchiBillingIntegration(organizationId:string,input:Record<string,unknown>):Promise<void>{return persistBillingConnection(organizationId,input);}
/** Internal adapter path: remote ownership and price were already verified in the same bounded operation. */
export async function saveVerifiedBillingConnection(organizationId:string,input:Partial<BillingConnection>,currency?:MoneyCurrency):Promise<void>{return persistBillingConnection(organizationId,input,{verifiedByAdapter:true,currency});}
/** Signed account-wide Stripe events use an existing provider identity, never an unsigned org query or arbitrary metadata. */
export async function findBillingOrganizationForCustomer(customerId:string,credentials=platformBillingCredentials()):Promise<string|null> {
  if(!/^cus_[a-zA-Z0-9]+$/.test(customerId))return null;
  const rows=await db.select({organizationId:gridProviders.organizationId}).from(gridProviders).where(and(inArray(gridProviders.key,[BILLING_CONNECTION_KEY,JPY_BILLING_CONNECTION_KEY]),eq(gridProviders.enabled,true),
    sql`${gridProviders.config}->>'stripeCustomerId' = ${customerId}`,sql`${gridProviders.config}->>'stripeAccountId' = ${credentials.stripeAccountId}`,sql`${gridProviders.config}->>'stripeLivemode' = ${String(credentials.livemode)}`)).limit(2);
  if(rows.length>1)throw new HiguchiIntegrationError("決済顧客の組織対応が重複しています。",409);
  return rows[0]?.organizationId??null;
}
export function getBillingReadiness(env:Record<string,string|undefined>=process.env):{connected:boolean;status:"ready"|"unconfigured";detail:string} {
  try{const c=platformBillingCredentials(env);assertPlatformBillingConfigured(c);return {connected:true,status:"ready",detail:`Stripeの専用料金設定を使用します。固定月額なし、営業メール1通${formatMoney(billingPolicy(c.currency).emailMinor,c.currency)}です。`};}
  catch{return {connected:false,status:"unconfigured",detail:"Stripeの運営用キー・専用料金・通知先を設定してください。"};}
}
