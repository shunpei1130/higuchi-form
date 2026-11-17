/**
 * Explicit sandbox-only protocol verification. Read the API key from stdin, never a file or argument.
 * Creates app-owned test fixtures, one synthetic metered unit, and no live charge or email.
 * Run only when the operator chooses to: bun --conditions=react-server scripts/higuchi-stripe-test.ts --key-stdin --account-id acct_1UcblRRGx64luiLk
 */
import { createHash, randomUUID } from "node:crypto";
import type { BillingCredentials } from "../src/lib/higuchi/billingCredentials";
import type { BillingDependencies } from "../src/lib/higuchi/providerBilling";

const TEST_ACCOUNT = "acct_1UcblRRGx64luiLk";
const APP = "higuchi-form";
const API_VERSION = "2026-10-28.endive";
type Json = Record<string, unknown>;
const object = (value:unknown):Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const resourceId = (value:unknown):string => typeof value === "string" ? value : typeof object(value).id === "string" ? String(object(value).id) : "";
let phase = "arguments";
class TestFailure extends Error {
  constructor(readonly status:string,readonly stripeStatus?:number,readonly stripeCode?:string,readonly parameter?:string){super(status);}
}
function check(value:unknown,status:string):asserts value { if(!value)throw new TestFailure(status); }

async function stdinKey():Promise<string> {
  check(!process.stdin.isTTY,"stdin_required");
  const chunks:Buffer[]=[];let length=0;
  for await(const chunk of process.stdin){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);length+=bytes.length;check(length<=16384,"stdin_too_large");chunks.push(bytes);}
  const key=Buffer.concat(chunks).toString("utf8").trim();
  check(/^(?:rk|sk)_test_[A-Za-z0-9_-]+$/.test(key),"dedicated_test_key_required");
  return key;
}

async function main():Promise<void> {
  const args=process.argv.slice(2);let keyStdin=false,accountId="";
  for(let index=0;index<args.length;index++){
    const argument=args[index];
    if(argument==="--help"){
      console.log("bun --conditions=react-server scripts/higuchi-stripe-test.ts --key-stdin --account-id acct_1UcblRRGx64luiLk");
      return;
    }
    if(argument==="--key-stdin"){check(!keyStdin,"duplicate_argument");keyStdin=true;continue;}
    if(argument==="--account-id"){check(!accountId,"duplicate_argument");accountId=args[++index]??"";continue;}
    throw new TestFailure("unsupported_argument");
  }
  check(keyStdin&&accountId===TEST_ACCOUNT,"dedicated_sandbox_required");
  phase="stdin";
  const key=await stdinKey();
  process.env.STRIPE_SECRET_KEY=key;
  process.env.STRIPE_ACCOUNT_ID=TEST_ACCOUNT;
  process.env.STRIPE_METER_EVENT_NAME="higuchi_email_sent_v1";
  process.env.HIGUCHI_MODE="live";
  // Runtime dependencies are loaded only after rejecting live keys and every other account.
  const api=await import("../src/lib/higuchi/providerBilling");
  const {createWorkspace}=await import("../src/lib/higuchi/state");
  const {applyBillingEvent}=await import("../src/lib/higuchi/billingState");
  check(api.STRIPE_API_VERSION===API_VERSION,"api_version_mismatch");

  const runId=randomUUID(),organizationId=randomUUID();
  const marker={higuchi_app:APP,higuchi_organization:organizationId,higuchi_purpose:"adapter_verification",higuchi_test_run:runId};
  const receipts:string[]=[];
  const deadline=AbortSignal.timeout(180000);
  const request:BillingDependencies["request"]=async(credentials,path,body,requestKey)=>{
    check(credentials.stripeAccountId===TEST_ACCOUNT&&!credentials.livemode&&/^(?:rk|sk)_test_/.test(credentials.stripeSecretKey),"test_scope_lost");
    deadline.throwIfAborted();
    const response=await fetch(`https://api.stripe.com/v1${path}`,{
      method:body?"POST":"GET",headers:{Authorization:`Bearer ${credentials.stripeSecretKey}`,"Stripe-Version":API_VERSION,
        ...(body?{"Content-Type":"application/x-www-form-urlencoded"}:{}),
        ...(requestKey?{"Idempotency-Key":`higuchi-${createHash("sha256").update(requestKey).digest("hex")}`}:{})},
      body:body?api.stripeForm(body):undefined,cache:"no-store",signal:AbortSignal.any([deadline,AbortSignal.timeout(25000)]),
    });
    // Provider bodies can contain secrets or payment details. Never place them in errors or output.
    const result=object(await response.json().catch(()=>null));
    if(!response.ok){const error=object(result.error),code=typeof error.code==="string"&&/^[a-z0-9_]{1,80}$/.test(error.code)?error.code:undefined,parameter=typeof error.param==="string"&&/^[a-zA-Z0-9_[\].]{1,100}$/.test(error.param)?error.param:undefined;throw new TestFailure("stripe_request_failed",response.status,code,parameter);}
    check(result.livemode!==true,"live_response_refused");
    if(path==="/billing/meter_events")receipts.push(typeof result.identifier==="string"?result.identifier:"");
    return result;
  };
  const credentials:BillingCredentials={stripeSecretKey:key,stripePublishableKey:"",stripeWebhookSecret:"",stripeAccountId:TEST_ACCOUNT,
    stripeProductId:"",stripeMeterId:"",stripePriceId:"",stripeEventName:"higuchi_email_sent_v1",stripeCustomerId:"",stripeSubscriptionId:"",livemode:false};
  const deps:Partial<BillingDependencies>={request,platform:()=>credentials,mode:()=>"live",credentials:async org=>{check(org===organizationId,"organization_mismatch");return credentials;},
    saveConnection:async(org,patch)=>{check(org===organizationId,"organization_mismatch");Object.assign(credentials,patch);},organizationForCustomer:async()=>null};
  const owns=(value:Json):boolean=>{const metadata=object(value.metadata);return value.livemode===false&&metadata.higuchi_app===APP&&metadata.higuchi_organization===organizationId;};

  phase="account";
  check((await request(credentials,"/account")).id===TEST_ACCOUNT,"account_mismatch");
  phase="catalog";
  const catalog=await api.provisionStripeBillingCatalog({},deps);
  Object.assign(credentials,{stripeProductId:catalog.productId,stripeMeterId:catalog.meterId,stripePriceId:catalog.priceId,stripeEventName:catalog.eventName});

  phase="customer";
  const customer=await request(credentials,"/customers",{name:"higuchi-form sandbox adapter verification",metadata:marker},`sandbox-customer:${runId}`);
  check(owns(customer)&&/^cus_/.test(resourceId(customer)),"customer_identity_failed");
  credentials.stripeCustomerId=resourceId(customer);

  phase="payment_method";
  // Stripe's public test token contains no PAN or real customer's payment details.
  const paymentMethod=await request(credentials,"/payment_methods",{type:"card",card:{token:"tok_visa"},metadata:marker},`sandbox-method:${runId}`);
  check(paymentMethod.livemode===false&&/^pm_/.test(resourceId(paymentMethod)),"test_method_failed");
  const paymentMethodId=resourceId(paymentMethod);
  const attached=await request(credentials,`/payment_methods/${encodeURIComponent(paymentMethodId)}/attach`,{customer:credentials.stripeCustomerId},`sandbox-attach:${runId}`);
  check(resourceId(attached.customer)===credentials.stripeCustomerId,"method_attachment_failed");

  phase="setup_intent";
  const setup=await request(credentials,"/setup_intents",{customer:credentials.stripeCustomerId,payment_method:paymentMethodId,
    confirm:true,usage:"off_session",automatic_payment_methods:{enabled:true,allow_redirects:"never"},metadata:marker},`sandbox-setup:${runId}`);
  check(owns(setup)&&setup.status==="succeeded"&&resourceId(setup.customer)===credentials.stripeCustomerId&&resourceId(setup.payment_method)===paymentMethodId,"setup_not_succeeded");
  await request(credentials,`/customers/${encodeURIComponent(credentials.stripeCustomerId)}`,{invoice_settings:{default_payment_method:paymentMethodId}},`sandbox-default-method:${runId}`);

  phase="trial_grant";
  await api.activateBillingTrial({organizationId,requestId:`trial:${runId}`},deps);
  await api.activateBillingTrial({organizationId,requestId:`trial:${runId}`},deps);
  const grantsResult=await request(credentials,`/billing/credit_grants?customer=${encodeURIComponent(credentials.stripeCustomerId)}&limit=100`);
  check(!grantsResult.has_more&&Array.isArray(grantsResult.data),"grant_list_incomplete");
  const grants=(grantsResult.data as unknown[]).map(object).filter(owns);
  check(grants.length===1,"trial_grant_not_unique");
  const grant=grants[0],money=object(object(grant.amount).monetary),scope=object(object(grant.applicability_config).scope);
  check(grant.category==="promotional"&&money.currency==="usd"&&money.value===3000&&!grant.voided_at&&
    Array.isArray(scope.prices)&&scope.prices.length===1&&resourceId(scope.prices[0])===credentials.stripePriceId,"trial_grant_scope_failed");

  phase="subscription";
  await api.configurePostpaidBilling({organizationId,requestId:`configure:${runId}`},deps);
  await api.configurePostpaidBilling({organizationId,requestId:`configure:${runId}`},deps);
  const subscription=await request(credentials,`/subscriptions/${encodeURIComponent(credentials.stripeSubscriptionId)}`);
  const items=object(subscription.items).data;
  check(owns(subscription)&&subscription.status==="active"&&resourceId(subscription.customer)===credentials.stripeCustomerId&&
    Array.isArray(items)&&items.length===1&&resourceId(object(items[0]).price)===credentials.stripePriceId&&
    object(subscription.billing_mode).type==="flexible"&&object(subscription.billing_thresholds).amount_gte===500&&
    object(subscription.billing_thresholds).reset_billing_cycle_anchor===false&&resourceId(subscription.default_payment_method)===paymentMethodId,"subscription_configuration_failed");

  phase="meter_acceptance";
  const at=new Date().toISOString(),messageId=`sandbox:${runId}`;
  const usage={organizationId,messageId,projectId:randomUUID(),campaignId:randomUUID(),kind:"initial" as const,at,firstAttemptAt:at};
  await api.sendUsageEvent(usage,deps);
  await api.sendUsageEvent(usage,deps);
  check(receipts.length===2&&receipts[0]&&receipts[0]===receipts[1],"meter_identifier_not_stable");

  phase="local_promotion_policy";
  // These checks exercise the real reducer in memory, not an invented paid Checkout receipt.
  const trialFirst=createWorkspace("live"),paidFirst=createWorkspace("live");
  const base={organizationId,providerCustomerId:credentials.stripeCustomerId,amountCents:0};
  applyBillingEvent(trialFirst,{...base,eventId:`setup:${runId}`,kind:"setup"});
  applyBillingEvent(trialFirst,{...base,eventId:`purchase:${runId}`,kind:"topup",amountCents:3000,creditCents:6000});
  check(trialFirst.internal.billingJobs.find(job=>job.kind==="topup")?.creditCents===3000&&trialFirst.billing.pendingCreditCents===6000,"trial_then_paid_policy_failed");
  applyBillingEvent(paidFirst,{...base,eventId:`purchase:${runId}`,kind:"topup",amountCents:3000,creditCents:6000});
  applyBillingEvent(paidFirst,{...base,eventId:`setup:${runId}`,kind:"setup"});
  check(!paidFirst.internal.billingJobs.some(job=>job.kind==="trial")&&paidFirst.billing.pendingCreditCents===6000,"paid_then_trial_policy_failed");

  phase="complete";
  console.log(JSON.stringify({accountId:TEST_ACCOUNT,mode:"test",status:"passed",runId,organizationId,
    productId:catalog.productId,meterId:catalog.meterId,priceId:catalog.priceId,customerId:credentials.stripeCustomerId,paymentMethodId,
    setupIntentId:resourceId(setup),subscriptionId:credentials.stripeSubscriptionId,creditGrantId:resourceId(grant),meterEventIdentifier:receipts[0],
    setupStatus:"succeeded",trialGrantStatus:"one_usd_30_promotional_price_scoped_grant",subscriptionStatus:"active",
    meterStatus:"same_identifier_accepted_twice_aggregate_not_checked",promotionPolicyStatus:"passed_local_reducer_only",
    prepaidCheckoutStatus:"manual_test_required",applicationWebhookStatus:"not_exercised",fixtureStatus:"retained_in_dedicated_sandbox"}));
}

if(import.meta.main){
  try{await main();}
  catch(error){console.error(JSON.stringify({accountId:TEST_ACCOUNT,mode:"test",status:"failed",phase,
    failureStatus:error instanceof TestFailure?error.status:"unexpected_failure",...(error instanceof TestFailure&&error.stripeStatus?{stripeStatus:error.stripeStatus}:{}),...(error instanceof TestFailure&&error.stripeCode?{stripeCode:error.stripeCode}:{}),...(error instanceof TestFailure&&error.parameter?{parameter:error.parameter}:{})}));process.exitCode=1;}
  finally{delete process.env.STRIPE_SECRET_KEY;}
}
