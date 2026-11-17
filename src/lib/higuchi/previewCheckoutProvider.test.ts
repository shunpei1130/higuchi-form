import { expect, test } from "bun:test";
import { readBillingElementsSession, expireBillingElementsSession, type BillingDependencies } from "./providerBilling";
import type { BillingCredentials } from "./billingCredentials";

const credentials:BillingCredentials={currency:"JPY",priceVersion:"jpy-6-v1",stripeSecretKey:"rk_test_fixture",stripePublishableKey:"pk_test_fixture",stripeWebhookSecret:"whsec_fixture",stripeAccountId:"acct_test",stripeProductId:"prod_jpy",stripeMeterId:"mtr_jpy",stripePriceId:"price_jpy",stripeEventName:"higuchi_email_sent_jpy_v1",stripeCustomerId:"cus_fixture",stripeSubscriptionId:"",livemode:false};
const input={organizationId:"organization",sessionId:"cs_test_fixture",currency:"JPY" as const,previewRunId:"run"};
function fixture(){
  const session={id:input.sessionId,livemode:false,customer:credentials.stripeCustomerId,currency:"jpy",mode:"payment",ui_mode:"elements",status:"open",amount_total:4500,client_secret:"cs_test_fixture_secret_value",metadata:{higuchi_app:"higuchi-form",higuchi_organization:input.organizationId,higuchi_currency:"JPY",higuchi_price_version:"jpy-6-v1",higuchi_preview_run:input.previewRunId}};
  const writes:string[]=[];
  const deps:Partial<BillingDependencies>={credentials:async()=>({...credentials}),request:async(_c,path,body)=>{
    if(path==="/account")return {id:credentials.stripeAccountId};
    if(path===`/checkout/sessions/${input.sessionId}`&&!body)return structuredClone(session);
    if(path===`/checkout/sessions/${input.sessionId}/expire`&&body){writes.push(path);session.status="expired";return structuredClone(session);}
    throw new Error("Unexpected provider call");
  }};
  return {session,writes,deps};
}
test("Session reuse reads exact organization/customer/run/currency ownership and performs no write",async()=>{
  const h=fixture();
  expect(await readBillingElementsSession(input,h.deps)).toMatchObject({sessionId:input.sessionId,status:"open",mode:"payment",amountMinor:4500,currency:"JPY",clientSecret:h.session.client_secret});
  for(const changed of [{organizationId:"other"},{previewRunId:"other"},{sessionId:"cs_test_other"}])await expect(readBillingElementsSession({...input,...changed},h.deps)).rejects.toThrow();
  h.session.metadata.higuchi_currency="USD";await expect(readBillingElementsSession(input,h.deps)).rejects.toThrow();expect(h.writes).toHaveLength(0);
});
test("only an owned open Session may be expired; completed payments are never replaced",async()=>{
  const h=fixture();expect(await expireBillingElementsSession(input,h.deps)).toMatchObject({status:"expired"});
  await expireBillingElementsSession(input,h.deps);expect(h.writes).toHaveLength(1);
  h.session.status="complete";await expect(expireBillingElementsSession(input,h.deps)).rejects.toThrow();expect(h.writes).toHaveLength(1);
});
