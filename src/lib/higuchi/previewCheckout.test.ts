import { expect, test } from "bun:test";
import { createWorkspace, activateJpyBilling } from "./state";
import { preparePreviewCheckout, type PreviewCheckoutDependencies, type PendingPreviewCheckout } from "./previewCheckout";
import type { BillingElementsSession } from "./providerBilling";

const runId="preview-run",returnUrl="https://form-higuchi.example/auto-gtm/preview-run?billing_return=1";
const selection={runId,mode:"payment" as const,amountMinor:4500,requestId:"client-a",returnUrl};
function harness(){
  let state=createWorkspace("live");activateJpyBilling(state);
  let at=1_800_000_000_000,sequence=0;
  const sessions=new Map<string,BillingElementsSession>(),keys=new Map<string,string>(),calls:string[]=[],attempts:PendingPreviewCheckout[]=[];
  const deps:PreviewCheckoutDependencies={
    mutate:async fn=>{const draft=structuredClone(state),result=fn(draft);state=draft;return result;},now:()=>at,
    create:async pending=>{
      attempts.push(structuredClone(pending));const previous=keys.get(pending.requestId!);if(previous){calls.push(`recover:${previous}`);return {sessionId:previous};}
      const sessionId=`cs_test_fixture${++sequence}`;
      sessions.set(sessionId,{sessionId,url:"",customerId:"cus_fixture",clientSecret:`${sessionId}_secret_fixture`,publishableKey:"pk_test_fixture",currency:"JPY",priceVersion:"jpy-6-v1",status:"open",mode:pending.mode,amountMinor:pending.amountMinor});
      keys.set(pending.requestId!,sessionId);calls.push(`create:${sessionId}`);return {sessionId};
    },
    read:async sessionId=>structuredClone(sessions.get(sessionId)!),
    expire:async sessionId=>{calls.push(`expire:${sessionId}`);const value=sessions.get(sessionId)!;if(value.status==="complete")throw new Error("Already confirmed");value.status="expired";return structuredClone(value);},
  };
  return {deps,sessions,keys,calls,attempts,get state(){return state;},advance:(value:number)=>{at+=value;},get now(){return at;}};
}

test("remounts and second tabs reuse the same open run/plan Session and immutable request",async()=>{
  const h=harness(),first=await preparePreviewCheckout(selection,h.deps),requestId=h.state.billing.pendingPreviewSessions![runId].requestId;
  const second=await preparePreviewCheckout({...selection,requestId:"different-client"},h.deps);
  expect(second.sessionId).toBe(first.sessionId);expect(h.calls).toEqual([`create:${first.sessionId}`]);
  expect(h.state.billing.pendingPreviewSessions![runId]).toMatchObject({sessionId:first.sessionId,requestId,mode:"payment",amountMinor:4500});
  expect(h.state.billing.pendingPreviewSessions![runId].lockId).toBeUndefined();
  expect(JSON.stringify(h.state)).not.toContain("_secret_");
});

test("a changed plan expires the old Session before creating another and leaves one open",async()=>{
  const h=harness(),first=await preparePreviewCheckout(selection,h.deps),second=await preparePreviewCheckout({...selection,amountMinor:7500},h.deps);
  expect(h.calls).toEqual([`create:${first.sessionId}`,`expire:${first.sessionId}`,`create:${second.sessionId}`]);
  expect(first.sessionId).not.toBe(second.sessionId);expect(h.sessions.get(first.sessionId)?.status).toBe("expired");
  expect([...h.sessions.values()].filter(session=>session.status==="open")).toHaveLength(1);
  expect(h.state.billing.pendingPreviewSessions![runId]).toMatchObject({sessionId:second.sessionId,amountMinor:7500});
});

test("completed Sessions and signed verified runs can never prepare another payment",async()=>{
  const h=harness(),first=await preparePreviewCheckout(selection,h.deps);
  h.sessions.get(first.sessionId)!.status="complete";
  await expect(preparePreviewCheckout({...selection,amountMinor:15000},h.deps)).rejects.toMatchObject({code:"CHECKOUT_ALREADY_CONFIRMED"});
  expect(h.calls).toHaveLength(1);expect(h.state.billing.pendingPreviewSessions![runId].sessionId).toBe(first.sessionId);
  h.state.billing.verifiedPreviewSessions={[runId]:{sessionId:first.sessionId,mode:"payment",amountMinor:4500,currency:"JPY",verifiedAt:new Date(h.now).toISOString()}};
  h.state.billing.pendingPreviewSessions![runId].lockId="crashed-owner";
  await expect(preparePreviewCheckout(selection,h.deps)).rejects.toMatchObject({code:"CHECKOUT_ALREADY_CONFIRMED"});
  expect(h.state.billing.pendingPreviewSessions![runId].lockId).toBeUndefined();expect(h.calls).toHaveLength(1);
});

test("if card confirmation wins an expiration race, no replacement is created",async()=>{
  const h=harness(),first=await preparePreviewCheckout(selection,h.deps);
  h.deps.expire=async sessionId=>{h.sessions.get(sessionId)!.status="complete";throw new Error("Confirmation won");};
  await expect(preparePreviewCheckout({...selection,amountMinor:7500},h.deps)).rejects.toMatchObject({code:"CHECKOUT_ALREADY_CONFIRMED"});
  expect(h.calls).toHaveLength(1);expect(h.state.billing.pendingPreviewSessions![runId].sessionId).toBe(first.sessionId);
});

test("a live lease prevents competing requests from making any additional Stripe calls",async()=>{
  const h=harness(),create=h.deps.create;
  let release!:()=>void,entered!:()=>void;
  const barrier=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  h.deps.create=async pending=>{const result=await create(pending);entered();await barrier;return result;};
  const first=preparePreviewCheckout(selection,h.deps);await started;
  await expect(preparePreviewCheckout({...selection,requestId:"client-b"},h.deps)).rejects.toMatchObject({code:"CHECKOUT_PREPARING"});
  expect(h.calls).toHaveLength(1);release();const result=await first;
  expect(h.state.billing.pendingPreviewSessions![runId].sessionId).toBe(result.sessionId);
});

test("a lost create response recovers the same request before expiring it for a changed plan",async()=>{
  const h=harness(),create=h.deps.create;let loseResponse=true;
  h.deps.create=async pending=>{const result=await create(pending);if(loseResponse){loseResponse=false;throw new Error("Response lost after Stripe committed");}return result;};
  await expect(preparePreviewCheckout(selection,h.deps)).rejects.toThrow("Response lost");
  const original=structuredClone(h.state.billing.pendingPreviewSessions![runId]);
  expect(original.sessionId).toBe("");expect(original.lockId).toBeUndefined();
  const recovered=await preparePreviewCheckout({...selection,amountMinor:7500,returnUrl:"https://form-higuchi.example/changed"},h.deps);
  expect(h.attempts[1]).toMatchObject({requestId:original.requestId,returnUrl:original.returnUrl,amountMinor:4500,firstPaymentBonus:original.firstPaymentBonus});
  expect(h.calls).toEqual(["create:cs_test_fixture1","recover:cs_test_fixture1","expire:cs_test_fixture1",`create:${recovered.sessionId}`]);
});

test("an expired lease recovers in-flight creation and fences a late old worker",async()=>{
  const h=harness(),create=h.deps.create;
  let release!:()=>void,entered!:()=>void,block=true;
  const barrier=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  h.deps.create=async pending=>{const result=await create(pending);if(block){block=false;entered();await barrier;}return result;};
  const first=preparePreviewCheckout(selection,h.deps);await started;h.advance(120001);
  const next=await preparePreviewCheckout({...selection,amountMinor:7500},h.deps);
  release();await expect(first).rejects.toMatchObject({code:"CHECKOUT_PREPARING"});
  expect(h.state.billing.pendingPreviewSessions![runId]).toMatchObject({sessionId:next.sessionId,amountMinor:7500});
  expect([...h.sessions.values()].filter(session=>session.status==="open")).toHaveLength(1);
});

test("old or unknown orphan attempts require recovery rather than a fresh financial Session",async()=>{
  const h=harness();
  h.state.billing.pendingPreviewSessions={[runId]:{sessionId:"",mode:"payment",amountMinor:4500,currency:"JPY",requestId:"old-unknown",returnUrl,createdAt:new Date(h.now-24*60*60*1000).toISOString()}};
  await expect(preparePreviewCheckout(selection,h.deps)).rejects.toMatchObject({code:"CHECKOUT_RECOVERY_REQUIRED"});
  expect(h.calls).toHaveLength(0);expect(h.state.billing.pendingPreviewSessions![runId].lockId).toBeUndefined();
});
