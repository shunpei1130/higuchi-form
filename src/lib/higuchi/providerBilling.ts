import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getHiguchiMode } from "./mode";
import { assertPlatformBillingConfigured, findBillingOrganizationForCustomer, platformBillingCredentials, requireBillingCredentials, saveVerifiedBillingConnection, type BillingConnection, type BillingCredentials } from "./billingCredentials";
import { HiguchiIntegrationError } from "./integrationError";

export const STRIPE_API_VERSION = "2026-10-28.endive";
const APP = "higuchi-form";
export class HiguchiBillingReconciliationError extends HiguchiIntegrationError {
  readonly reconciliationRequired=true;
  constructor(message:string){super(message,409);this.name="HiguchiBillingReconciliationError";}
}
type Json = Record<string,unknown>;
function object(value:unknown):Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function text(value:unknown,label:string):string { if (typeof value !== "string" || !value) throw new HiguchiIntegrationError(`${label}を確認できませんでした。`); return value; }
function cents(value:unknown):number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new HiguchiIntegrationError("決済金額の形式が正しくありません。",400); return value; }
function resourceId(value:unknown):string { return typeof value === "string" ? value : typeof object(value).id === "string" ? String(object(value).id) : ""; }
const hash = (value:string) => createHash("sha256").update(value).digest("hex");
const idempotencyKey = (value:string) => `higuchi-${hash(value)}`;
const metadata = (organizationId:string,extra:Json={}) => ({higuchi_app:APP,higuchi_organization:organizationId,...extra});
function owns(value:Json,organizationId?:string):boolean { const m=object(value.metadata);return m.higuchi_app===APP&&(!organizationId||m.higuchi_organization===organizationId); }
function assertMode(value:Json,credentials:BillingCredentials):void { if(typeof value.livemode==="boolean"&&value.livemode!==credentials.livemode)throw new HiguchiIntegrationError("Stripeのテスト環境と本番環境が一致しません。"); }
function assertOwned(value:Json,organizationId:string,credentials:BillingCredentials):void { assertMode(value,credentials);if(!owns(value,organizationId))throw new HiguchiIntegrationError("higuchi-form専用の決済情報として確認できません。既存の別サービスの顧客は利用できません。"); }

export function stripeForm(input:Json):URLSearchParams {
  const form=new URLSearchParams();
  const append=(key:string,value:unknown):void=>{if(value===undefined||value===null)return;if(Array.isArray(value))value.forEach((item,index)=>append(`${key}[${index}]`,item));else if(typeof value==="object")Object.entries(value).forEach(([child,item])=>append(`${key}[${child}]`,item));else form.append(key,String(value));};
  Object.entries(input).forEach(([key,value])=>append(key,value));return form;
}
async function stripeRequest(credentials:BillingCredentials,path:string,body?:Json,requestKey?:string,operationSignal?:AbortSignal):Promise<Json> {
  const timeout=AbortSignal.timeout(25000);
  const response=await fetch(`https://api.stripe.com/v1${path}`,{method:body?"POST":"GET",headers:{Authorization:`Bearer ${credentials.stripeSecretKey}`,"Stripe-Version":STRIPE_API_VERSION,...(body?{"Content-Type":"application/x-www-form-urlencoded"}:{}),...(requestKey?{"Idempotency-Key":idempotencyKey(requestKey)}:{})},body:body?stripeForm(body):undefined,cache:"no-store",signal:operationSignal?AbortSignal.any([timeout,operationSignal]):timeout});
  const result=object(await response.json().catch(()=>null));
  if(!response.ok)throw new HiguchiIntegrationError(`決済サービスへの接続に失敗しました（${response.status}）。`,502);
  return result;
}
/** Test seam supplies protocol fixtures without reading credentials, opening the database, or charging. */
export type BillingDependencies = {
  request:typeof stripeRequest;credentials:(organizationId:string)=>Promise<BillingCredentials>;platform:()=>BillingCredentials;
  saveConnection:(organizationId:string,connection:Partial<BillingConnection>)=>Promise<void>;
  organizationForCustomer:(customerId:string,credentials:BillingCredentials)=>Promise<string|null>;
  now:()=>number;mode:()=>"simulation"|"live";
};
const defaults:BillingDependencies={request:stripeRequest,credentials:requireBillingCredentials,platform:platformBillingCredentials,saveConnection:saveVerifiedBillingConnection,organizationForCustomer:findBillingOrganizationForCustomer,now:Date.now,mode:getHiguchiMode};
const dependencies=(override?:Partial<BillingDependencies>):BillingDependencies=>{
  // All requests in one job share a 55-second wall clock, including pagination and retries after an interrupted operation.
  const operation=AbortSignal.timeout(55000);
  return {...defaults,request:(credentials,path,body,key)=>{operation.throwIfAborted();return stripeRequest(credentials,path,body,key,operation);},saveConnection:(org,connection)=>{operation.throwIfAborted();return saveVerifiedBillingConnection(org,connection);},...override};
};
async function listAll(d:BillingDependencies,c:BillingCredentials,path:string):Promise<Json[]> {
  const rows:Json[]=[];let cursor="";
  for(let page=0;page<100;page++){
    const result=await d.request(c,`${path}${path.includes("?")?"&":"?"}limit=100${cursor?`&starting_after=${encodeURIComponent(cursor)}`:""}`);
    const batch=Array.isArray(result.data)?result.data.map(object):[];rows.push(...batch);
    if(!result.has_more)return rows;
    cursor=text(batch.at(-1)?.id,"決済一覧の続き");
  }
  throw new HiguchiIntegrationError("決済一覧が大きいため、運営者による照合が必要です。");
}
async function verifyAccount(d:BillingDependencies,c:BillingCredentials):Promise<void> { const account=await d.request(c,"/account");if(account.id!==c.stripeAccountId)throw new HiguchiIntegrationError("Stripeの接続先アカウントが設定と一致しません。"); }
async function verifyCatalog(d:BillingDependencies,c:BillingCredentials):Promise<void> {
  const price=await d.request(c,`/prices/${encodeURIComponent(c.stripePriceId)}`);assertMode(price,c);
  const recurring=object(price.recurring);
  if(price.active!==true||price.currency!=="usd"||price.unit_amount!==4||resourceId(price.product)!==c.stripeProductId||recurring.interval!=="month"||recurring.usage_type!=="metered"||resourceId(recurring.meter)!==c.stripeMeterId||!owns(price))throw new HiguchiIntegrationError("営業メール1通$0.04の専用料金を確認できません。");
  const product=await d.request(c,`/products/${encodeURIComponent(c.stripeProductId)}`);if(!owns(product)||product.active!==true)throw new HiguchiIntegrationError("higuchi-form専用の商品を確認できません。");
  const meter=await d.request(c,`/billing/meters/${encodeURIComponent(c.stripeMeterId)}`);
  if(meter.status!=="active"||meter.event_name!==c.stripeEventName||object(meter.default_aggregation).formula!=="sum"||object(meter.value_settings).event_payload_key!=="value"||object(meter.customer_mapping).event_payload_key!=="stripe_customer_id")throw new HiguchiIntegrationError("higuchi-form専用の利用量メーターを確認できません。");
}
async function ensureCustomer(d:BillingDependencies,c:BillingCredentials,organizationId:string,email?:string):Promise<Json> {
  await verifyAccount(d,c);
  if(c.stripeCustomerId){const customer=await d.request(c,`/customers/${encodeURIComponent(c.stripeCustomerId)}`);assertOwned(customer,organizationId,c);return customer;}
  // Listing the app-owned identity also recovers creation after a crash beyond Stripe's 24-hour request-key window.
  const matches=(await listAll(d,c,"/customers")).filter(customer=>owns(customer,organizationId)&&!customer.deleted);
  if(matches.length>1)throw new HiguchiIntegrationError("専用の決済顧客が複数あります。運営者による照合が必要です。");
  const customer=matches[0]??await d.request(c,"/customers",{name:"higuchi-form",...(email?{email}:{}),metadata:metadata(organizationId)},`customer:${organizationId}`);
  assertOwned(customer,organizationId,c);c.stripeCustomerId=text(customer.id,"決済顧客ID");
  await d.saveConnection(organizationId,{stripeCustomerId:c.stripeCustomerId});return customer;
}
export function validatedBillingReturnUrl(input:string):string {
  const url=new URL(input),origin=process.env.BETTER_AUTH_URL||process.env.NEXT_PUBLIC_APP_URL;
  if(!origin||url.origin!==new URL(origin).origin||!["https:","http:"].includes(url.protocol)||(url.protocol!=="https:"&&!["localhost","127.0.0.1","[::1]"].includes(url.hostname)))throw new Error("決済後の戻り先URLが正しくありません。");return url.href;
}
export type BillingCheckoutResult={url:string;sessionId:string;customerId:string;clientSecret?:string;publishableKey?:string};
type CheckoutInput={organizationId:string;returnUrl:string;requestId:string;email?:string;embedded?:boolean};
function checkoutResult(session:Json,c:BillingCredentials,fallback:string):BillingCheckoutResult { return {url:typeof session.url==="string"?session.url:fallback,sessionId:text(session.id,"決済セッション"),customerId:c.stripeCustomerId,...(typeof session.client_secret==="string"?{clientSecret:session.client_secret,publishableKey:c.stripePublishableKey}:{})}; }
function checkoutOptions(input:CheckoutInput,returnUrl:string):Json { return {customer:undefined,client_reference_id:input.organizationId,locale:"ja",integration_identifier:`higuchi_${Array.from(createHash("sha256").update(input.requestId).digest().subarray(0,8),byte=>String.fromCharCode(97+byte%26)).join("")}`,...(input.embedded?{ui_mode:"embedded",return_url:returnUrl}:{success_url:returnUrl,cancel_url:returnUrl})}; }
export async function createBillingSetup(input:CheckoutInput,override?:Partial<BillingDependencies>):Promise<BillingCheckoutResult> {
  const d=dependencies(override),returnUrl=validatedBillingReturnUrl(input.returnUrl);
  if(d.mode()==="simulation")return {url:returnUrl,sessionId:idempotencyKey(input.requestId),customerId:"simulation_customer"};
  const c=await d.credentials(input.organizationId);await verifyCatalog(d,c);await ensureCustomer(d,c,input.organizationId,input.email);
  const session=await d.request(c,"/checkout/sessions",{...checkoutOptions(input,returnUrl),mode:"setup",currency:"usd",customer:c.stripeCustomerId,metadata:metadata(input.organizationId,{higuchi_purpose:"trial_setup"})},`setup:${input.organizationId}:${input.requestId}`);
  return checkoutResult(session,c,returnUrl);
}
export async function createBillingCheckout(input:CheckoutInput&{amountCents:number;firstPaymentBonus?:boolean},override?:Partial<BillingDependencies>):Promise<BillingCheckoutResult> {
  const amount=cents(input.amountCents);if(![3000,5000,10000].includes(amount))throw new Error("追加金額は$30、$50、$100から選択してください。");
  const d=dependencies(override),returnUrl=validatedBillingReturnUrl(input.returnUrl);
  if(d.mode()==="simulation")return {url:returnUrl,sessionId:idempotencyKey(input.requestId),customerId:"simulation_customer"};
  const c=await d.credentials(input.organizationId);await verifyCatalog(d,c);await ensureCustomer(d,c,input.organizationId,input.email);
  const purchaseMetadata=metadata(input.organizationId,{higuchi_purpose:"credit_topup",higuchi_credit_cents:String(input.firstPaymentBonus?amount*2:amount)});
  const session=await d.request(c,"/checkout/sessions",{...checkoutOptions(input,returnUrl),mode:"payment",customer:c.stripeCustomerId,metadata:purchaseMetadata,
    payment_intent_data:{setup_future_usage:"off_session",metadata:purchaseMetadata},line_items:[{quantity:1,price_data:{currency:"usd",unit_amount:amount,product_data:{name:"higuchi-form 利用クレジット",metadata:{higuchi_app:APP}}}}]},`topup:${input.organizationId}:${input.requestId}`);
  return checkoutResult(session,c,returnUrl);
}
export async function createBillingPortal(input:{organizationId:string;customerId:string;returnUrl:string},override?:Partial<BillingDependencies>):Promise<{url:string}> {
  const d=dependencies(override),returnUrl=validatedBillingReturnUrl(input.returnUrl);
  if(d.mode()==="simulation")return {url:returnUrl};
  const c=await d.credentials(input.organizationId);if(!c.stripeCustomerId||input.customerId!==c.stripeCustomerId)throw new HiguchiIntegrationError("決済顧客が見つかりません。");
  await ensureCustomer(d,c,input.organizationId);
  const session=await d.request(c,"/billing_portal/sessions",{customer:c.stripeCustomerId,return_url:returnUrl,locale:"ja"});return {url:text(session.url,"お支払い管理画面")};
}

async function ensureSubscription(d:BillingDependencies,c:BillingCredentials,organizationId:string):Promise<Json> {
  const customer=await ensureCustomer(d,c,organizationId);await verifyCatalog(d,c);
  const paymentMethod=resourceId(object(customer.invoice_settings).default_payment_method);if(!paymentMethod)throw new HiguchiIntegrationError("従量料金の支払方法を確認してください。");
  const candidates=(await listAll(d,c,`/subscriptions?customer=${encodeURIComponent(c.stripeCustomerId)}&status=all`)).filter(sub=>owns(sub,organizationId)&&!["canceled","incomplete_expired"].includes(String(sub.status)));
  if(candidates.length>1)throw new HiguchiIntegrationError("従量課金の契約が複数あります。運営者による照合が必要です。");
  let subscription:Json;
  if(c.stripeSubscriptionId){subscription=await d.request(c,`/subscriptions/${encodeURIComponent(c.stripeSubscriptionId)}`);}
  else subscription=candidates[0]??await d.request(c,"/subscriptions",{customer:c.stripeCustomerId,items:[{price:c.stripePriceId}],billing_mode:{type:"flexible"},billing_thresholds:{amount_gte:500,reset_billing_cycle_anchor:false},collection_method:"charge_automatically",default_payment_method:paymentMethod,payment_behavior:"default_incomplete",metadata:metadata(organizationId)},`subscription:${organizationId}`);
  assertOwned(subscription,organizationId,c);
  const items=object(subscription.items).data;
  if(resourceId(subscription.customer)!==c.stripeCustomerId||!Array.isArray(items)||items.length!==1||resourceId(object(items[0]).price)!==c.stripePriceId||object(subscription.billing_mode).type!=="flexible"||object(subscription.billing_thresholds).amount_gte!==500||object(subscription.billing_thresholds).reset_billing_cycle_anchor!==false||subscription.collection_method!=="charge_automatically")throw new HiguchiIntegrationError("専用の従量課金契約が設定と一致しません。");
  if(resourceId(subscription.default_payment_method)!==paymentMethod){
    subscription=await d.request(c,`/subscriptions/${encodeURIComponent(text(subscription.id,"従量課金契約"))}`,{default_payment_method:paymentMethod},`subscription-method:${subscription.id}:${paymentMethod}`);
    assertOwned(subscription,organizationId,c);
  }
  if(subscription.status!=="active")throw new HiguchiIntegrationError("従量課金の契約が有効ではありません。支払方法を確認してください。");
  const subscriptionId=text(subscription.id,"従量課金契約");if(c.stripeSubscriptionId!==subscriptionId){await d.saveConnection(organizationId,{stripeCustomerId:c.stripeCustomerId,stripeSubscriptionId:subscriptionId});c.stripeSubscriptionId=subscriptionId;}
  return subscription;
}
export async function configurePostpaidBilling(input:{organizationId:string;requestId:string},override?:Partial<BillingDependencies>):Promise<void> { const d=dependencies(override);if(d.mode()==="simulation")return;await ensureSubscription(d,await d.credentials(input.organizationId),input.organizationId); }
async function ensureCreditGrant(d:BillingDependencies,c:BillingCredentials,input:{organizationId:string;operation:string;amount:number;category:"paid"|"promotional";name:string}):Promise<string> {
  const operation=hash(input.operation);
  const matches=(await listAll(d,c,`/billing/credit_grants?customer=${encodeURIComponent(c.stripeCustomerId)}`)).filter(grant=>owns(grant,input.organizationId)&&object(grant.metadata).higuchi_operation===operation);
  if(matches.length>1)throw new HiguchiBillingReconciliationError("利用クレジットが重複しています。運営者による照合が必要です。");
  const grant=matches[0]??await d.request(c,"/billing/credit_grants",{customer:c.stripeCustomerId,name:input.name,amount:{type:"monetary",monetary:{currency:"usd",value:cents(input.amount)}},applicability_config:{scope:{prices:[{id:c.stripePriceId}]}},category:input.category,priority:input.category==="promotional"?1:100,metadata:metadata(input.organizationId,{higuchi_operation:operation})},`grant:${input.operation}`);
  assertOwned(grant,input.organizationId,c);
  const monetary=object(object(grant.amount).monetary),scope=object(object(grant.applicability_config).scope),prices=Array.isArray(scope.prices)?scope.prices:[];
  if(resourceId(grant.customer)!==c.stripeCustomerId||grant.category!==input.category||monetary.currency!=="usd"||monetary.value!==input.amount||prices.length!==1||resourceId(prices[0])!==c.stripePriceId||grant.voided_at||grant.expires_at&&Number(grant.expires_at)*1000<=d.now())throw new HiguchiBillingReconciliationError("利用クレジットの内容が一致しません。");
  return text(grant.id,"利用クレジットID");
}
export async function activateBillingTrial(input:{organizationId:string;requestId:string;at?:string},override?:Partial<BillingDependencies>):Promise<void> {
  const d=dependencies(override);if(d.mode()==="simulation")return;const c=await d.credentials(input.organizationId);await ensureCustomer(d,c,input.organizationId);await verifyCatalog(d,c);
  // This is monetary promotional credit, never a time-based subscription trial.
  await ensureCreditGrant(d,c,{organizationId:input.organizationId,operation:`trial:${input.organizationId}`,amount:3000,category:"promotional",name:"higuchi-form 初回無料クレジット"});
}
export async function grantBillingTopup(input:{organizationId:string;amountCents:number;creditCents?:number;requestId:string;at?:string},override?:Partial<BillingDependencies>):Promise<void> {
  const d=dependencies(override);if(d.mode()==="simulation")return;const paid=cents(input.amountCents),credit=cents(input.creditCents??paid);if(![3000,5000,10000].includes(paid)||![paid,paid*2].includes(credit))throw new HiguchiIntegrationError("利用クレジットの金額が正しくありません。");
  const c=await d.credentials(input.organizationId);await ensureCustomer(d,c,input.organizationId);await verifyCatalog(d,c);
  const sessionId=input.requestId.match(/^topup:stripe-topup:(cs_[a-zA-Z0-9_]+)$/)?.[1];if(!sessionId)throw new HiguchiIntegrationError("購入の確認IDが正しくありません。");
  const purchase=await d.request(c,`/checkout/sessions/${encodeURIComponent(sessionId)}`);assertOwned(purchase,input.organizationId,c);
  if(resourceId(purchase.customer)!==c.stripeCustomerId||purchase.payment_status!=="paid"||purchase.amount_total!==paid||purchase.currency!=="usd"||object(purchase.metadata).higuchi_purpose!=="credit_topup")throw new HiguchiIntegrationError("購入の支払確認が完了していません。");
  const payment=await d.request(c,`/payment_intents/${encodeURIComponent(text(resourceId(purchase.payment_intent),"購入の支払いID"))}`);assertOwned(payment,input.organizationId,c);
  const chargeId=resourceId(payment.latest_charge);if(!chargeId)throw new HiguchiIntegrationError("購入の支払い結果を確認できません。");
  const charge=await d.request(c,`/charges/${encodeURIComponent(chargeId)}`);if(charge.disputed||Number(charge.amount_refunded)>0||payment.status!=="succeeded"||resourceId(payment.customer)!==c.stripeCustomerId||payment.amount_received!==paid||payment.currency!=="usd"||object(payment.metadata).higuchi_purpose!=="credit_topup")throw new HiguchiBillingReconciliationError("返金・支払い確認待ちの購入にクレジットを追加できません。");
  await ensureCreditGrant(d,c,{organizationId:input.organizationId,operation:`paid:${input.organizationId}:${input.requestId}`,amount:paid,category:"paid",name:"higuchi-form 支払済みクレジット"});
  if(credit>paid)await ensureCreditGrant(d,c,{organizationId:input.organizationId,operation:`bonus:${input.organizationId}:${input.requestId}`,amount:credit-paid,category:"promotional",name:"higuchi-form 初回購入特典"});
}
export async function sendUsageEvent(input:{organizationId:string;messageId:string;projectId:string;campaignId:string;at:string;kind:"initial"|"followup";firstAttemptAt?:string},override?:Partial<BillingDependencies>):Promise<void> {
  const d=dependencies(override);if(d.mode()==="simulation")return;
  if(!["initial","followup"].includes(input.kind))throw new HiguchiIntegrationError("返信は従量料金の対象ではありません。");
  const timestamp=Date.parse(input.at),first=Date.parse(input.firstAttemptAt??input.at);
  if(!Number.isFinite(timestamp)||timestamp<d.now()-35*86400000||timestamp>d.now()+300000)throw new HiguchiBillingReconciliationError("利用記録の日時がStripeの受付期間外です。運営者による照合が必要です。");
  // Stripe's meter-event identifier guarantees deduplication for at least 24 hours only.
  if(!Number.isFinite(first)||d.now()-first>23*3600000)throw new HiguchiBillingReconciliationError("利用記録の再送期間を過ぎています。重複課金を避けるため運営者が照合してください。");
  const c=await d.credentials(input.organizationId);if(!c.stripeCustomerId||!c.stripeSubscriptionId)throw new HiguchiIntegrationError("従量課金の接続が未完了です。");
  const identifier=idempotencyKey(`email:${input.organizationId}:${input.messageId}`);
  const event=await d.request(c,"/billing/meter_events",{event_name:c.stripeEventName,payload:{stripe_customer_id:c.stripeCustomerId,value:"1"},identifier,timestamp:Math.floor(timestamp/1000)},`usage:${input.organizationId}:${input.messageId}`);
  if(event.identifier!==identifier)throw new HiguchiBillingReconciliationError("利用記録の受付を確認できません。運営者による照合が必要です。");
}

function sameHex(a:string,b:string):boolean{return /^[0-9a-f]{64}$/i.test(a)&&/^[0-9a-f]{64}$/i.test(b)&&timingSafeEqual(Buffer.from(a,"hex"),Buffer.from(b,"hex"));}
export function verifyStripeSignature(raw:string,header:string,secret:string,now=Date.now()):boolean {const values=header.split(",").map(value=>value.split("=")),timestamp=values.find(([key])=>key==="t")?.[1];if(!timestamp||!/^\d+$/.test(timestamp)||Math.abs(now-Number(timestamp)*1000)>300000)return false;const expected=createHmac("sha256",secret).update(`${timestamp}.${raw}`).digest("hex");return values.some(([key,value])=>key==="v1"&&sameHex(value??"",expected));}
export type VerifiedBillingEvent={eventId:string;organizationId:string;amountCents:number;creditCents?:number;kind:"topup"|"setup"|"payment_failed"|"payment_paid"|"refund";providerCustomerId?:string;providerSubscriptionId?:string;providerCreatedAt?:number;invoiceId?:string;refundChargeId?:string;reconciliationRequired?:boolean};
async function readWebhook(request:Request):Promise<string>{if(Number(request.headers.get("content-length")??0)>1048576)throw new HiguchiIntegrationError("通知が大きすぎます。",413);const reader=request.body?.getReader();if(!reader)return "";const chunks:Uint8Array[]=[];let length=0;try{while(true){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.length;if(length>1048576){await reader.cancel();throw new HiguchiIntegrationError("通知が大きすぎます。",413);}chunks.push(chunk.value);}}finally{reader.releaseLock();}return Buffer.concat(chunks).toString("utf8");}
function invoiceSubscription(invoice:Json):string{return resourceId(object(object(invoice.parent).subscription_details).subscription)||resourceId(invoice.subscription);}
async function invoiceUsageLines(d:BillingDependencies,c:BillingCredentials,organizationId:string,invoice:Json):Promise<Json[]|null>{
  const subId=invoiceSubscription(invoice);if(!subId||subId!==c.stripeSubscriptionId)return null;
  const subscription=await d.request(c,`/subscriptions/${encodeURIComponent(subId)}`);assertOwned(subscription,organizationId,c);
  if(resourceId(subscription.customer)!==c.stripeCustomerId)return null;
  const lines=await listAll(d,c,`/invoices/${encodeURIComponent(text(invoice.id,"請求ID"))}/lines`);
  return lines.length>0&&lines.every(line=>{const price=resourceId(object(object(line.pricing).price_details).price)||resourceId(line.price);return price===c.stripePriceId&&line.currency==="usd";})?lines:null;
}
export function invoiceUsageSettlement(lines:Json[]):number {
  // subtotal is before discounts and taxes. pretax_credit_amounts includes both discounts and Billing Credit Grants.
  const total=lines.reduce((sum,line)=>{if(!Number.isSafeInteger(line.subtotal))throw new HiguchiIntegrationError("請求明細の税抜金額を確認できません。運営者による照合が必要です。");
    const credits=Array.isArray(line.pretax_credit_amounts)?line.pretax_credit_amounts:[];
    const applied=credits.reduce((value:number,entry)=>{const credit=object(entry);if(!["discount","credit_balance_transaction"].includes(String(credit.type))||!Number.isSafeInteger(credit.amount))throw new HiguchiIntegrationError("請求明細のクレジットを確認できません。");return value+Number(credit.amount);},0);
    return sum+Number(line.subtotal)-applied;},0);
  if(!Number.isSafeInteger(total))throw new HiguchiIntegrationError("請求明細の合計が正しくありません。");return Math.max(0,total);
}
/** One account-wide signed endpoint; unmapped customers and other EC products are intentionally ignored. */
export async function verifyBillingWebhook(request:Request,override?:Partial<BillingDependencies>):Promise<VerifiedBillingEvent|null>{
  const d=dependencies(override);if(d.mode()!=="live")throw new HiguchiIntegrationError("シミュレーション中は外部決済通知を受け付けません。",409);
  const platform=d.platform();assertPlatformBillingConfigured(platform);const raw=await readWebhook(request);
  if(!verifyStripeSignature(raw,request.headers.get("stripe-signature")??"",platform.stripeWebhookSecret,d.now()))throw new HiguchiIntegrationError("通知の署名を確認できません。",400);
  let event:Json;try{event=object(JSON.parse(raw));}catch{throw new HiguchiIntegrationError("通知の形式が正しくありません。",400);}
  if(event.livemode!==platform.livemode||event.account&&event.account!==platform.stripeAccountId)throw new HiguchiIntegrationError("通知の決済環境が一致しません。",400);
  const eventId=text(event.id,"通知ID"),type=text(event.type,"通知種別");let data=object(object(event.data).object),charge:Json|undefined;
  if(["charge.dispute.created","radar.early_fraud_warning.created"].includes(type)){const chargeId=resourceId(data.charge);if(!chargeId)return null;charge=await d.request(platform,`/charges/${encodeURIComponent(chargeId)}`);}
  const customerId=resourceId((charge??data).customer);if(!customerId)return null;
  const organizationId=await d.organizationForCustomer(customerId,platform);if(!organizationId)return null;
  const c=await d.credentials(organizationId);if(c.stripeCustomerId!==customerId)throw new HiguchiIntegrationError("通知の決済顧客が一致しません。",400);
  const customer=await d.request(c,`/customers/${encodeURIComponent(customerId)}`);assertOwned(customer,organizationId,c);
  const base={eventId,organizationId,amountCents:0,providerCustomerId:customerId,providerCreatedAt:typeof event.created==="number"?event.created:undefined};
  if(type.startsWith("checkout.session.")){
    if(!owns(data,organizationId)||data.client_reference_id!==organizationId)return null;
    // Re-fetch immutable Checkout/Intent state; redirects and event metadata alone cannot grant credit.
    data=await d.request(c,`/checkout/sessions/${encodeURIComponent(text(data.id,"決済セッション"))}`);
    if(!owns(data,organizationId)||resourceId(data.customer)!==customerId||data.client_reference_id!==organizationId)throw new HiguchiIntegrationError("決済セッションの対応が一致しません。",400);
    const purpose=object(data.metadata).higuchi_purpose;
    if(type==="checkout.session.async_payment_failed"&&purpose==="credit_topup")return {...base,kind:"payment_failed"};
    if(!["checkout.session.completed","checkout.session.async_payment_succeeded"].includes(type))return null;
    if(data.mode==="setup"&&purpose==="trial_setup"&&data.status==="complete"){
      const setupId=text(resourceId(data.setup_intent),"支払方法の確認ID"),setup=await d.request(c,`/setup_intents/${encodeURIComponent(setupId)}`);
      if(setup.status!=="succeeded"||resourceId(setup.customer)!==customerId)throw new HiguchiIntegrationError("支払方法の確認が完了していません。",409);
      await d.request(c,`/customers/${encodeURIComponent(customerId)}`,{invoice_settings:{default_payment_method:text(resourceId(setup.payment_method),"支払方法")}},`default-payment:${setupId}`);
      return {...base,eventId:`stripe-setup:${text(data.id,"決済セッション")}`,kind:"setup"};
    }
    if(data.mode!=="payment"||purpose!=="credit_topup"||data.payment_status!=="paid")return null;
    const amount=cents(data.amount_total),credit=Number(object(data.metadata).higuchi_credit_cents);if(data.currency!=="usd"||![3000,5000,10000].includes(amount)||![amount,amount*2].includes(credit))throw new HiguchiIntegrationError("購入金額が一致しません。",400);
    const paymentId=text(resourceId(data.payment_intent),"支払いID"),payment=await d.request(c,`/payment_intents/${encodeURIComponent(paymentId)}`);
    assertOwned(payment,organizationId,c);
    if(payment.status!=="succeeded"||resourceId(payment.customer)!==customerId||payment.currency!=="usd"||payment.amount_received!==amount||object(payment.metadata).higuchi_purpose!=="credit_topup")throw new HiguchiIntegrationError("支払いの確認が完了していません。",409);
    await d.request(c,`/customers/${encodeURIComponent(customerId)}`,{invoice_settings:{default_payment_method:text(resourceId(payment.payment_method),"支払方法")}},`default-payment:${paymentId}`);
    return {...base,eventId:`stripe-topup:${text(data.id,"決済セッション")}`,kind:"topup",amountCents:amount,creditCents:credit};
  }
  if(type.startsWith("invoice.")){
    data=await d.request(c,`/invoices/${encodeURIComponent(text(data.id,"請求ID"))}`);
    if(resourceId(data.customer)!==customerId)throw new HiguchiIntegrationError("請求の顧客が一致しません。",400);
    const lines=await invoiceUsageLines(d,c,organizationId,data);if(!lines)return null;
    if(data.status==="paid"&&["invoice.payment_failed","invoice.payment_action_required"].includes(type))return null;
    if(["invoice.payment_failed","invoice.payment_action_required"].includes(type))return {...base,kind:"payment_failed",providerSubscriptionId:c.stripeSubscriptionId};
    if(["invoice.voided","invoice.marked_uncollectible"].includes(type))return {...base,kind:"payment_failed",providerSubscriptionId:c.stripeSubscriptionId,reconciliationRequired:true};
    if(type!=="invoice.paid"||data.status!=="paid"||data.currency!=="usd")return null;
    // Cash excluding tax settles usage debt. Credit-grant consumption must never mint a second prepaid balance.
    const cash=invoiceUsageSettlement(lines);
    return {...base,eventId:`stripe-invoice:${text(data.id,"請求ID")}`,kind:"payment_paid",amountCents:cash,invoiceId:text(data.id,"請求ID"),providerSubscriptionId:c.stripeSubscriptionId};
  }
  if(type.startsWith("customer.subscription.")){
    if(!owns(data,organizationId)||data.id!==c.stripeSubscriptionId)return null;
    const subscription=await d.request(c,`/subscriptions/${encodeURIComponent(c.stripeSubscriptionId)}`);assertOwned(subscription,organizationId,c);
    if(["active"].includes(String(subscription.status)))return null;
    return {...base,kind:"payment_failed",providerSubscriptionId:c.stripeSubscriptionId};
  }
  if(type==="charge.refunded"||charge){
    charge??=data;const paymentId=resourceId(charge.payment_intent);if(!paymentId)return null;
    const payment=await d.request(c,`/payment_intents/${encodeURIComponent(paymentId)}`);
    const topup=owns(payment,organizationId)&&object(payment.metadata).higuchi_purpose==="credit_topup";
    let appInvoice=false;let ambiguousInvoicePayment=false;const invoiceId=resourceId(charge.invoice);
    if(invoiceId){const invoice=await d.request(c,`/invoices/${encodeURIComponent(invoiceId)}`);appInvoice=Boolean(await invoiceUsageLines(d,c,organizationId,invoice));}
    else if(!topup){
      // Current Stripe versions link PaymentIntents and invoices through InvoicePayment, not charge.invoice.
      const payments=await listAll(d,c,`/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=${encodeURIComponent(paymentId)}`);
      const invoiceIds=[...new Set(payments.map(row=>resourceId(row.invoice)).filter(Boolean))];
      for(const id of invoiceIds){const invoice=await d.request(c,`/invoices/${encodeURIComponent(id)}`);if(resourceId(invoice.customer)===customerId&&await invoiceUsageLines(d,c,organizationId,invoice))appInvoice=true;}
      ambiguousInvoicePayment=invoiceIds.length!==1;
    }
    if(!topup&&!appInvoice)return null;
    if(type!=="charge.refunded")return {...base,kind:"payment_failed",reconciliationRequired:true};
    if(appInvoice&&ambiguousInvoicePayment)return {...base,kind:"payment_failed",reconciliationRequired:true};
    const refunded=cents(charge.amount_refunded??0);if(charge.currency!=="usd")throw new HiguchiIntegrationError("返金の通貨が一致しません。",400);
    if(topup){
      const sessions=(await listAll(d,c,`/checkout/sessions?payment_intent=${encodeURIComponent(paymentId)}`)).filter(session=>owns(session,organizationId));
      if(sessions.length!==1)throw new HiguchiIntegrationError("返金に対応する購入を確認できません。",409);
      const requestId=`topup:stripe-topup:${text(sessions[0].id,"購入セッション")}`;
      const operations=[hash(`paid:${organizationId}:${requestId}`),hash(`bonus:${organizationId}:${requestId}`)];
      const grants=(await listAll(d,c,`/billing/credit_grants?customer=${encodeURIComponent(customerId)}`)).filter(grant=>owns(grant,organizationId)&&operations.includes(String(object(grant.metadata).higuchi_operation)));
      for(const grant of grants)if(!grant.voided_at&&(!grant.expires_at||Number(grant.expires_at)*1000>d.now()))await d.request(c,`/billing/credit_grants/${encodeURIComponent(text(grant.id,"返金対象クレジット"))}/expire`,{},`refund-expire:${charge.id}:${grant.id}`);
    }
    return {...base,eventId:`stripe-refund:${text(charge.id,"返金対象")}:${refunded}`,kind:"refund",amountCents:refunded,refundChargeId:text(charge.id,"返金対象"),reconciliationRequired:true};
  }
  return null;
}
/** Retired endpoint compatibility: never accepts unsigned legacy usage-payment updates. */
export async function verifyMetronomeWebhook(_request:Request):Promise<VerifiedBillingEvent|null>{throw new HiguchiIntegrationError("この決済通知先は終了しました。Stripeの共通通知先を使用してください。",410);}

/** Explicit operator provisioning only. No callers run this during application startup or customer checkout. */
export async function provisionStripeBillingCatalog(input:{allowLive?:boolean}={},override?:Partial<BillingDependencies>):Promise<{productId:string;meterId:string;priceId:string;eventName:string}>{
  const d=dependencies(override),c=d.platform();assertPlatformBillingConfigured(c,{catalog:false,webhook:false});
  if(c.livemode&&!input.allowLive)throw new HiguchiIntegrationError("料金設定は最初にStripeのテスト環境で作成してください。");
  await verifyAccount(d,c);
  const products=(await listAll(d,c,"/products?active=true")).filter(product=>owns(product)&&object(product.metadata).higuchi_role==="email_usage_v1");if(products.length>1)throw new HiguchiIntegrationError("専用の商品が複数あります。");
  const product=products[0]??await d.request(c,"/products",{name:"higuchi-form 営業メール従量利用",description:"初回・フォローアップメール1通$0.04。固定月額なし。返信は無料。",metadata:{higuchi_app:APP,higuchi_role:"email_usage_v1"}},"catalog:product:v1");
  const meters=(await listAll(d,c,"/billing/meters?status=active")).filter(meter=>meter.event_name===c.stripeEventName);if(meters.length>1)throw new HiguchiIntegrationError("専用の利用メーターが複数あります。");
  const meter=meters[0]??await d.request(c,"/billing/meters",{display_name:"higuchi-form 営業メール送信数",event_name:c.stripeEventName,default_aggregation:{formula:"sum"},value_settings:{event_payload_key:"value"},customer_mapping:{type:"by_id",event_payload_key:"stripe_customer_id"}},"catalog:meter:v1");
  const productId=text(product.id,"商品ID"),meterId=text(meter.id,"メーターID"),lookupKey="higuchi_form_email_usd_4c_v1";
  const prices=await listAll(d,c,`/prices?active=true&lookup_keys[]=${lookupKey}`);if(prices.length>1)throw new HiguchiIntegrationError("専用の料金が複数あります。");
  const price=prices[0]??await d.request(c,"/prices",{product:productId,currency:"usd",unit_amount:4,recurring:{interval:"month",usage_type:"metered",meter:meterId},lookup_key:lookupKey,metadata:{higuchi_app:APP,higuchi_role:"email_usage_v1"}},"catalog:price:v1");
  const priceId=text(price.id,"料金ID");await verifyCatalog(d,{...c,stripeProductId:productId,stripeMeterId:meterId,stripePriceId:priceId});return {productId,meterId,priceId,eventName:c.stripeEventName};
}
