/** Full HTTP smoke test against an explicit, loopback-only simulation server. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { WorkspaceAction, WorkspaceSnapshot } from "../../src/lib/higuchi/types";

const base = new URL(process.env.BASE_URL || "http://127.0.0.1:3000");
assert(["127.0.0.1","localhost","[::1]"].includes(base.hostname),"Refusing nonlocal test server");
function client() {
  let cookie = "";
  return async (action?:WorkspaceAction) => {
    const response=await fetch(new URL(action?"/api/higuchi/actions":"/api/higuchi/workspace",base),{
      method:action?"POST":"GET",headers:{...(cookie?{Cookie:cookie}:{}),...(action?{"Content-Type":"application/json",Origin:base.origin}:{})},body:action?JSON.stringify(action):undefined,
    });
    const setCookie=response.headers.get("set-cookie");if(setCookie)cookie=setCookie.split(";")[0];
    const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));
    return data as WorkspaceSnapshot;
  };
}
const a=client(),b=client();
let state=await a();assert.equal(state.mode,"simulation");assert.equal(state.billing.balanceCents,0);
const authSession=await fetch(new URL("/api/auth/get-session",base));assert.equal(authSession.status,200);assert.equal(await authSession.json(),null);
const authMutation=await fetch(new URL("/api/auth/sign-in/email-otp",base),{method:"POST",headers:{"Content-Type":"application/json",Origin:base.origin},body:"{}"});assert.equal(authMutation.status,409,"Simulation must not activate real login or email");
const inheritedApi=await fetch(new URL("/api/campaigns",base));assert.equal(inheritedApi.status,409,"Simulation must not activate inherited database APIs");
const font=await fetch(new URL("/fonts/Geist-Variable.woff2",base));assert.equal(font.status,200);assert.equal(font.redirected,false);assert((await font.arrayBuffer()).byteLength>10000,"Public font must not redirect to sign-in");
const campaign=state.campaigns[0],lead=state.leads[0];assert(campaign&&lead,"Expected fictional sample data");
const verificationId=randomUUID();
state=await a({type:"billing.verify",requestId:verificationId});assert.equal(state.billing.balanceCents,3000);
state=await a({type:"billing.verify",requestId:verificationId});assert.equal(state.ledger.filter(e=>e.kind==="trial").length,1);
// This test runs on any weekday. Explicitly enable every day for the sample campaign.
state=await a({type:"campaign.update",campaignId:campaign.id,sendWeekdays:[0,1,2,3,4,5,6]});
state=await a({type:"campaign.start",campaignId:campaign.id});
state=await a({type:"simulation.tick",advanceMinutes:1});
assert(state.campaigns[0].sentCount>0,"Campaign must progress through actual HTTP actions");
assert(state.conversations.some(thread=>thread.leadId===lead.id));
state=await a({type:"simulation.reply",leadId:lead.id,body:"詳しい内容を伺いたいです。打ち合わせをお願いします。",requestId:randomUUID()});
const thread=state.conversations.find(t=>t.leadId===lead.id)!;
state=await a({type:"inbox.note",conversationId:thread.id,notes:"HTTP確認用の共有メモ"});
assert.equal(state.conversations.find(t=>t.id===thread.id)?.notes,"HTTP確認用の共有メモ");
state=await a({type:"campaign.stop",campaignId:campaign.id});
const countBefore=state.conversations.reduce((n,t)=>n+t.messages.length,0);
state=await a({type:"simulation.tick",advanceMinutes:120});
assert.equal(state.conversations.reduce((n,t)=>n+t.messages.length,0),countBefore,"Stopped campaigns must not send replies");
state=await a({type:"campaign.start",campaignId:campaign.id});
const startsAt=new Date(Date.parse(state.now)+86400000).toISOString();
state=await a({type:"simulation.booking",leadId:lead.id,startsAt,requestId:randomUUID()});
assert(state.meetings.some(m=>m.leadId===lead.id&&m.status==="booked"));
state=await a({type:"lead.suppress",leadId:lead.id});
assert.equal(state.leads.find(l=>l.id===lead.id)?.status,"suppressed");
state=await a({type:"campaign.archive",campaignId:campaign.id});
assert.equal(state.campaigns[0].status,"archived");assert.equal(state.campaigns[0].autoReply,false);
const fresh=await b();assert.equal(fresh.billing.balanceCents,0);assert.equal(fresh.meetings.length,0);assert(!fresh.campaigns.some(c=>c.id===campaign.id),"Sessions must stay isolated");
const originalProjects=new Set(fresh.projects.map(project=>project.id));
const createdState=await b({type:"project.create",name:"HTTP検証プロジェクト",description:"架空の業務支援サービスです。",icp:"日本の中小企業",geography:"日本"});
const created=createdState.projects.find(project=>!originalProjects.has(project.id));assert(created,"Onboarding must create a separate project");
const csv="name,email,company,role\n検証 太郎,http-smoke@csv.example,HTTP検証社（架空）,営業責任者";
let csvState=await b({type:"leads.import",projectId:created.id,csv});assert.equal(csvState.leads.filter(lead=>lead.projectId===created.id&&lead.email==="http-smoke@csv.example").length,1);
csvState=await b({type:"leads.import",projectId:created.id,csv});assert.equal(csvState.leads.filter(lead=>lead.projectId===created.id&&lead.email==="http-smoke@csv.example").length,1,"Repeated CSV must not duplicate the lead");
const badOrigin=await fetch(new URL("/api/higuchi/actions",base),{method:"POST",headers:{"Content-Type":"application/json",Origin:"https://untrusted.example"},body:JSON.stringify({type:"simulation.reset"})});assert.equal(badOrigin.status,403);
console.log("PASS: HTTP project creation, CSV import/dedup, billing grant dedup, outbound, inbox notes, stop, booking, suppression, archive, session isolation, CSRF, simulation auth/provider boundaries and public font.");
