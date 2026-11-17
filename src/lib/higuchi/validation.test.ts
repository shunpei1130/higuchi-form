import { afterAll, describe, expect, test } from "bun:test";
import { assertSameOrigin } from "./service";
import { validateAction } from "./validation";

const previousMode=process.env.HIGUCHI_MODE,previousOrigin=process.env.BETTER_AUTH_URL;
afterAll(()=>{if(previousMode===undefined)delete process.env.HIGUCHI_MODE;else process.env.HIGUCHI_MODE=previousMode;if(previousOrigin===undefined)delete process.env.BETTER_AUTH_URL;else process.env.BETTER_AUTH_URL=previousOrigin;});
describe("request boundary",()=>{
  test("simulation accepts loopback aliases only on same scheme and port",()=>{
    process.env.HIGUCHI_MODE="simulation";
    expect(()=>assertSameOrigin(new Request("http://localhost:3000/api/higuchi/actions",{headers:{Host:"127.0.0.1:3000",Origin:"http://127.0.0.1:3000"}}))).not.toThrow();
    expect(()=>assertSameOrigin(new Request("http://localhost:3000/api/higuchi/actions",{headers:{Host:"127.0.0.1:3000",Origin:"http://evil.example:3000"}}))).toThrow();
    expect(()=>assertSameOrigin(new Request("http://localhost:3000/api/higuchi/actions",{headers:{Host:"localhost:3000",Origin:"http://localhost:4000"}}))).toThrow();
    expect(()=>assertSameOrigin(new Request("http://localhost:3000/api/higuchi/actions"))).toThrow();
  });
  test("live compares the public configured origin, not internal binding",()=>{
    process.env.HIGUCHI_MODE="live";process.env.BETTER_AUTH_URL="https://higuchi.example";
    expect(()=>assertSameOrigin(new Request("http://localhost:3000/api/higuchi/actions",{headers:{Origin:"https://higuchi.example"}}))).not.toThrow();
    expect(()=>assertSameOrigin(new Request("http://localhost:3000/api/higuchi/actions",{headers:{Origin:"http://localhost:3000"}}))).toThrow();
  });
  test("unknown and prototype keys are rejected rather than assigned",()=>{
    expect(()=>validateAction(JSON.parse('{"type":"settings.update","settings":{"__proto__":{"polluted":true}}}'))).toThrow();
    expect(()=>validateAction({type:"settings.update",settings:{billingConfigured:true}})).toThrow();
    expect(()=>validateAction({type:"campaign.update",campaignId:"one",dailyBudgetCents:NaN})).toThrow();
    expect(()=>validateAction({type:"campaign.start",campaignId:"one",organizationId:"other"})).toThrow();
    expect(({} as {polluted?:boolean}).polluted).toBeUndefined();
  });
});
