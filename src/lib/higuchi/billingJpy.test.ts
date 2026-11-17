import {expect,test} from "bun:test";
import {createHmac} from "node:crypto";
import {activateJpyBilling,createWorkspace,normalizeWorkspaceState} from "./state";
import {applyAction,reserveEmail} from "./engine";
import {applyBillingEvent} from "./billingState";
import {activateBillingTrial,configurePostpaidBilling,createBillingSetup,grantBillingTopup,verifyBillingWebhook,type BillingDependencies} from "./providerBilling";
import type {BillingCredentials} from "./billingCredentials";
import {billingPolicy,formatMoney} from "./money";

const at="2026-11-17T00:00:00.000Z",now=Date.parse(at),org="org_jpy";
const c:BillingCredentials={currency:"JPY",priceVersion:"jpy-6-v1",stripeSecretKey:"rk_test_fixture",stripePublishableKey:"pk_test_fixture",stripeWebhookSecret:"whsec_fixture",stripeAccountId:"acct_fixture",stripeProductId:"prod_jpy",stripeMeterId:"mtr_jpy",stripePriceId:"price_jpy",stripeEventName:"higuchi_email_sent_jpy_v1",stripeCustomerId:"cus_jpy",stripeSubscriptionId:"",livemode:false};
const meta={higuchi_app:"higuchi-form",higuchi_organization:org,higuchi_currency:"JPY",higuchi_price_version:"jpy-6-v1"};
type Call={path:string;body?:Record<string,unknown>};
function fixture(){
  const calls:Call[]=[];
  const customer={id:c.stripeCustomerId,livemode:false,metadata:meta,invoice_settings:{default_payment_method:"pm_jpy"}};
  const price={id:c.stripePriceId,active:true,livemode:false,currency:"jpy",unit_amount:6,product:c.stripeProductId,metadata:meta,recurring:{interval:"month",usage_type:"metered",meter:c.stripeMeterId}};
  const purchase={id:"cs_jpy",livemode:false,mode:"payment",client_reference_id:org,customer:c.stripeCustomerId,payment_status:"paid",amount_total:4500,currency:"jpy",payment_intent:"pi_jpy",metadata:{...meta,higuchi_purpose:"credit_topup",higuchi_credit_cents:"9000"}};
  const deps:Partial<BillingDependencies>={mode:()=>"live",now:()=>now,credentials:async(_org,currency)=>{if(currency&&currency!=="JPY")throw new Error("wrong currency mapping");return {...c};},platform:()=>({...c}),saveConnection:async()=>{},organizationForCustomer:async id=>id===c.stripeCustomerId?org:null,request:async(_c,path,body)=>{
    calls.push({path,body});if(path==="/account")return {id:c.stripeAccountId};if(path===`/customers/${c.stripeCustomerId}`)return customer;if(path===`/prices/${c.stripePriceId}`)return price;if(path===`/products/${c.stripeProductId}`)return {id:c.stripeProductId,active:true,metadata:meta};
    if(path===`/billing/meters/${c.stripeMeterId}`)return {status:"active",event_name:c.stripeEventName,default_aggregation:{formula:"sum"},value_settings:{event_payload_key:"value"},customer_mapping:{event_payload_key:"stripe_customer_id"}};
    if(path.startsWith("/subscriptions?")||path.startsWith("/billing/credit_grants?"))return {data:[],has_more:false};
    if(path==="/subscriptions")return {...body,id:"sub_jpy",status:"active",livemode:false,items:{data:[{price}]}};
    if(path==="/billing/credit_grants")return {...body,id:`credgr_${calls.length}`,livemode:false};
    if(path==="/checkout/sessions")return {id:"cs_setup",client_secret:"cs_setup_secret_fixture"};
    if(path==="/checkout/sessions/cs_jpy")return purchase;
    if(path==="/payment_intents/pi_jpy")return {id:"pi_jpy",customer:c.stripeCustomerId,status:"succeeded",currency:"jpy",amount_received:4500,latest_charge:"ch_jpy",payment_method:"pm_jpy",metadata:{...meta,higuchi_purpose:"credit_topup"}};
    if(path==="/charges/ch_jpy")return {id:"ch_jpy",amount_refunded:0,disputed:false};throw new Error(`Unexpected fixture: ${path}`);
  }};return {deps,calls,purchase};
}

test("JPY is integer yen; free allowance and prepaid bonus remain exclusive",()=>{
  expect(formatMoney(4500,"JPY")).toBe("￥4,500");expect(billingPolicy("JPY").thresholdMinor).toBe(750);
  const trial=createWorkspace("simulation",at,"JPY");applyAction(trial,{type:"billing.verify",requestId:"trial"});expect(trial.billing.balanceCents).toBe(4500);applyAction(trial,{type:"billing.topup",amountCents:4500,requestId:"purchase"});expect(trial.billing.balanceCents).toBe(9000);
  const paid=createWorkspace("simulation",at,"JPY");applyAction(paid,{type:"billing.topup",amountCents:4500,requestId:"purchase"});applyAction(paid,{type:"billing.verify",requestId:"trial"});expect(paid.billing.balanceCents).toBe(9000);expect(paid.ledger.filter(e=>e.kind==="trial")).toHaveLength(0);
});
test("legacy USD amounts and history survive the new default without conversion",()=>{
  const state=createWorkspace("live",at,"USD");state.billing.balanceCents=3000;delete state.billing.priceVersion;state.ledger.push({id:"old",projectId:null,campaignId:null,at,kind:"trial",amountCents:3000,dedupeKey:"old",description:"legacy"});
  const normalized=normalizeWorkspaceState(state);expect(state.billing.currency).toBe("USD");expect(normalized.billing.priceVersion).toBe("usd-4c-v1");expect(state.ledger[0].currency).toBe("USD");expect(state.billing.balanceCents).toBe(3000);expect(()=>activateJpyBilling(state)).toThrow("自動変換");
});
test("reviewed individual draft is used unchanged and explicit template edits invalidate it",()=>{
  const state=createWorkspace("simulation",at,"JPY"),campaign=state.campaigns[0],lead=state.leads[0];applyAction(state,{type:"billing.verify",requestId:"trial"});campaign.status="running";lead.preparedEmail={subject:"確認済みの件名",body:"確認済みの文面",revision:4};
  const out=reserveEmail(state,campaign,lead,"regenerate must not win","initial","reviewed");expect(out?.reservationCents).toBe(6);expect(out?.prepared).toBe(true);expect(out?.subject).toBe("確認済みの件名");expect(out?.body).toBe("確認済みの文面");
  applyAction(state,{type:"campaign.update",campaignId:campaign.id,emailBody:"利用者が編集"});expect(lead.preparedEmail).toBeUndefined();
});
test("a currency-mismatched signed event cannot change a JPY balance",()=>{
  const state=createWorkspace("live",at,"JPY");expect(()=>applyBillingEvent(state,{organizationId:org,eventId:"old-usd",kind:"topup",currency:"USD",amountCents:3000,creditCents:6000})).toThrow("通貨");expect(state.billing.balanceCents).toBe(0);expect(state.internal.providerEvents).toHaveLength(0);
});
test("only the latest pending Checkout Session can authorize a preview start",()=>{
  const state=createWorkspace("live",at,"JPY"),runId="00000000-0000-0000-0000-000000000001";
  state.billing.pendingPreviewSessions={[runId]:{sessionId:"cs_latest",mode:"payment",amountMinor:4500,currency:"JPY"}};
  applyBillingEvent(state,{organizationId:org,eventId:"stripe-topup:cs_latest",kind:"topup",currency:"JPY",amountCents:4500,creditCents:9000,previewRunId:runId,checkoutSessionId:"cs_latest"});
  expect(state.billing.verifiedPreviewSessions?.[runId].sessionId).toBe("cs_latest");
  applyBillingEvent(state,{organizationId:org,eventId:"stripe-setup:cs_old",kind:"setup",currency:"JPY",amountCents:0,previewRunId:runId,checkoutSessionId:"cs_old"});
  expect(state.billing.verifiedPreviewSessions?.[runId]).toMatchObject({sessionId:"cs_latest",mode:"payment",amountMinor:4500,currency:"JPY"});
});
test("JPY setup uses Elements Sessions, never a standalone SetupIntent write",async()=>{
  const previous=process.env.BETTER_AUTH_URL;process.env.BETTER_AUTH_URL="https://higuchi.example";
  try{const {deps,calls}=fixture();const result=await createBillingSetup({organizationId:org,currency:"JPY",returnUrl:"https://higuchi.example/app/billing",requestId:"setup",uiMode:"elements"},deps);const session=calls.find(x=>x.path==="/checkout/sessions")?.body;expect(session?.mode).toBe("setup");expect(session?.ui_mode).toBe("elements");expect(session?.currency).toBe("jpy");expect(session?.success_url).toBeUndefined();expect(result.clientSecret).toBe("cs_setup_secret_fixture");expect(calls.some(x=>x.path==="/setup_intents")).toBe(false);}finally{if(previous===undefined)delete process.env.BETTER_AUTH_URL;else process.env.BETTER_AUTH_URL=previous;}
});
test("JPY native grants and threshold use exact yen and the JPY price",async()=>{
  const {deps,calls}=fixture();await activateBillingTrial({organizationId:org,currency:"JPY",requestId:"trial"},deps);await grantBillingTopup({organizationId:org,currency:"JPY",amountCents:4500,creditCents:9000,requestId:"topup:stripe-topup:cs_jpy"},deps);await configurePostpaidBilling({organizationId:org,currency:"JPY",requestId:"configure"},deps);
  const grants=calls.filter(x=>x.path==="/billing/credit_grants");expect(grants).toHaveLength(3);for(const grant of grants){expect((grant.body?.amount as {monetary:{currency:string}}).monetary.currency).toBe("jpy");expect(grant.body?.applicability_config).toEqual({scope:{prices:[{id:c.stripePriceId}]}});}expect(calls.find(x=>x.path==="/subscriptions")?.body?.billing_thresholds).toEqual({amount_gte:750,reset_billing_cycle_anchor:false});
});
test("JPY verified purchase records immutable first-payment identifiers for guarantee review",async()=>{
  const {deps,purchase}=fixture(),raw=JSON.stringify({id:"evt_jpy",type:"checkout.session.completed",created:now/1000,livemode:false,data:{object:purchase}}),sig=createHmac("sha256",c.stripeWebhookSecret).update(`${now/1000}.${raw}`).digest("hex");
  const event=await verifyBillingWebhook(new Request("https://higuchi.example/api/webhooks/stripe",{method:"POST",body:raw,headers:{"stripe-signature":`t=${now/1000},v1=${sig}`}}),deps);expect(event?.currency).toBe("JPY");expect(event?.paymentIntentId).toBe("pi_jpy");
  const state=createWorkspace("live",at,"JPY");applyBillingEvent(state,event!);expect(state.billing.firstPrepayment).toEqual({sessionId:"cs_jpy",paymentIntentId:"pi_jpy",chargeId:"ch_jpy",amountMinor:4500,currency:"JPY",priceVersion:"jpy-6-v1",purchasedAt:at});applyBillingEvent(state,{...event!,eventId:"another",amountCents:7500});expect(state.billing.firstPrepayment?.amountMinor).toBe(4500);
});
