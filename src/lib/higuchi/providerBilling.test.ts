import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { stripeForm, verifyStripeSignature, validatedBillingReturnUrl } from "./providerBilling";

describe("Stripe signed notifications",()=>{
  const now=Date.UTC(2026,10,16,0,0,0),timestamp=String(now/1000),secret="whsec_unit_test",raw='{"id":"evt_1","data":{"amount":3000}}';
  const signature=createHmac("sha256",secret).update(`${timestamp}.${raw}`).digest("hex");
  test("checks raw bytes, current timestamp, and rotated signatures",()=>{
    expect(verifyStripeSignature(raw,`t=${timestamp},v1=${"0".repeat(64)},v1=${signature}`,secret,now)).toBe(true);
    expect(verifyStripeSignature(`${raw} `,`t=${timestamp},v1=${signature}`,secret,now)).toBe(false);
    expect(verifyStripeSignature(raw,`t=${timestamp},v1=${signature}`,secret,now+300001)).toBe(false);
    expect(verifyStripeSignature(raw,`t=${timestamp},v1=${signature}`,secret,now-300001)).toBe(false);
    expect(verifyStripeSignature(raw,`t=x,v1=${signature}`,secret,now)).toBe(false);
  });
});
test("Stripe form encoding preserves nested fields without injecting parameters",()=>{
  const encoded=stripeForm({metadata:{company:"A&B=Admin"},line_items:[{quantity:1,price_data:{unit_amount:3000}}]});
  expect(encoded.get("metadata[company]")).toBe("A&B=Admin");
  expect(encoded.get("line_items[0][price_data][unit_amount]")).toBe("3000");
  expect(encoded.get("Admin")).toBeNull();
});
test("billing redirect rejects cross-origin return destinations",()=>{
  const previous=process.env.BETTER_AUTH_URL;
  try { process.env.BETTER_AUTH_URL="https://higuchi.example";
    expect(validatedBillingReturnUrl("https://higuchi.example/app/billing")).toBe("https://higuchi.example/app/billing");
    expect(()=>validatedBillingReturnUrl("https://attacker.example/app/billing")).toThrow();
    expect(()=>validatedBillingReturnUrl("http://higuchi.example/app/billing")).toThrow();
  } finally { if(previous===undefined)delete process.env.BETTER_AUTH_URL;else process.env.BETTER_AUTH_URL=previous; }
});
