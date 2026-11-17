import { expect,test } from "bun:test";
import { isHiguchiPublicPath,isPublicBookingPath } from "./boundary";
import { bootstrapPlan,bootstrapEnabledForWeb,OPERATOR_EMAIL } from "../auth/operatorBootstrapPolicy";
const token="a".repeat(43);
test("booking tokens are public but booking settings and operator endpoints stay private",()=>{
  for(const route of [`/book/${token}`,`/book/manage/${token}`,`/api/booking/${token}`,`/api/booking/manage/${token}`])expect(isPublicBookingPath(route)).toBe(true);
  for(const route of ["/api/booking/settings","/api/booking/meetings","/api/higuchi/admin","/api/higuchi/mail","/api/higuchi/mail/callback",`/api/booking/${token}/settings`,`/api/booking/${token.slice(1)}`])expect(isHiguchiPublicPath(route)).toBe(false);
});
test("webhook and cron exceptions never expose adjacent routes or legacy workers",()=>{
  for(const route of ["/api/webhooks/stripe","/api/higuchi/mail/resend/webhook","/api/higuchi/cron","/api/outreach/unsubscribe"])expect(isHiguchiPublicPath(route)).toBe(true);
  for(const route of ["/api/webhooks/stripe/debug","/api/webhooks/metronome","/api/webhooks/calcom","/api/outreach/webhooks/gmail-watch","/api/outreach/tick","/api/higuchi/cron/jobs","/api/higuchi/mail/resend/webhook/debug","/api/mcp","/api/authentication"])expect(isHiguchiPublicPath(route)).toBe(false);
});
test("operator bootstrap only creates from an empty identity store",()=>{
  expect(bootstrapPlan({users:[],organizations:[],members:[]})).toEqual({status:"create"});
  expect(()=>bootstrapPlan({users:[{id:"x",email:"other@example.com"}],organizations:[],members:[]})).toThrow();
  expect(()=>bootstrapPlan({users:[{id:"x",email:OPERATOR_EMAIL}],organizations:[],members:[]})).toThrow();
});
test("a matching bootstrap is idempotent without changing verification or owner state",()=>{
  const snapshot={users:[{id:"u",email:OPERATOR_EMAIL}],organizations:[{id:"o",name:"MAORA",slug:"maora",metadata:JSON.stringify({initial:true,bootstrapOperatorEmail:OPERATOR_EMAIL})}],members:[{organizationId:"o",userId:"u",role:"owner"}]};
  expect(bootstrapPlan(snapshot)).toEqual({status:"ready",organizationId:"o",userId:"u"});
  expect(()=>bootstrapPlan({...snapshot,members:[{organizationId:"o",userId:"u",role:"member"}]})).toThrow();
  expect(()=>bootstrapPlan({...snapshot,organizations:[{...snapshot.organizations[0],metadata:JSON.stringify({initial:true})}]})).toThrow();
});
test("production cannot use the web first-user setup",()=>{
  expect(bootstrapEnabledForWeb({nodeEnv:"production"})).toBe(false);expect(bootstrapEnabledForWeb({nodeEnv:"development",vercel:"1"})).toBe(false);expect(bootstrapEnabledForWeb({nodeEnv:"development"})).toBe(true);
});
