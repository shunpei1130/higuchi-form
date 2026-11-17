import { describe, expect, test } from "bun:test";
import { applyAction, REVIEW_MS, runWorkspaceTick, canReserveEmail, reserveEmail, evaluateAutopilot } from "./engine";
import { createWorkspace } from "./state";
import { parseLeadCsv } from "./csv";
import { applyBillingEvent } from "./billingState";

const monday="2026-11-16T01:00:00.000Z";
function funded(){const s=createWorkspace("simulation",monday);applyAction(s,{type:"billing.verify",requestId:"verify-one"});return s;}
describe("higuchi campaign and delivery rules",()=>{
  test("no free credits before verified card; trial once",()=>{
    const s=createWorkspace("simulation",monday);expect(s.billing.balanceCents).toBe(0);
    applyAction(s,{type:"billing.verify",requestId:"one"});applyAction(s,{type:"billing.verify",requestId:"two"});
    expect(s.billing.balanceCents).toBe(3000);expect(s.ledger.filter(e=>e.kind==="trial")).toHaveLength(1);
  });
  test("free trial and first paid double credits cannot stack",()=>{
    const trial=funded();applyAction(trial,{type:"billing.topup",amountCents:3000,requestId:"paid"});expect(trial.billing.balanceCents).toBe(6000);
    const paid=createWorkspace("simulation",monday);applyAction(paid,{type:"billing.topup",amountCents:3000,requestId:"first"});expect(paid.billing.balanceCents).toBe(6000);
    applyAction(paid,{type:"billing.verify",requestId:"later-trial"});expect(paid.billing.balanceCents).toBe(6000);expect(paid.ledger.filter(e=>e.kind==="trial")).toHaveLength(0);
  });
  test("geography and selected structured segment persist in campaign proposals",()=>{
    const s=funded();applyAction(s,{type:"project.create",name:"海外向け",description:"営業支援",geography:"シンガポール"});const p=s.projects.at(-1)!;
    p.segments=[{name:"現地のIT責任者",locations:["シンガポール"],roles:["CTO"],companySizes:["11-50"],includeCriteria:"現地IT企業",excludeCriteria:"競合",valueProposition:"営業効率化",painPoints:"営業工数",emailInstructions:"丁寧に案内"}];
    applyAction(s,{type:"campaign.propose",projectId:p.id,segmentIndex:0});const c=s.campaigns.at(-1)!;expect(c.audience).toBe("現地IT企業");expect(c.targeting.locations).toEqual(["シンガポール"]);expect(p.geography).toBe("シンガポール");
  });
  test("daily project budget includes concurrent reservations and sends only once",()=>{
    const s=funded(),c=s.campaigns[0];s.projects[0].dailyBudgetCents=4;c.dailyBudgetCents=100;
    applyAction(s,{type:"campaign.start",campaignId:c.id});runWorkspaceTick(s);runWorkspaceTick(s);
    expect(c.sentCount).toBe(1);expect(s.billing.balanceCents).toBe(2996);expect(s.ledger.filter(e=>e.kind==="email")).toHaveLength(1);
    expect(canReserveEmail(s,c)).toBe(false);
  });
  test("UTC day budget resets but monthly budget remains",()=>{
    const s=funded(),c=s.campaigns[0];s.projects[0].dailyBudgetCents=4;s.projects[0].monthlyBudgetCents=8;c.dailyBudgetCents=4;
    applyAction(s,{type:"campaign.start",campaignId:c.id});runWorkspaceTick(s);s.now="2026-11-17T01:00:00.000Z";runWorkspaceTick(s);
    expect(c.sentCount).toBe(2);s.now="2026-11-18T01:00:00.000Z";runWorkspaceTick(s);expect(c.sentCount).toBe(2);
  });
  test("manual and automatic replies cost no email credits",()=>{
    const s=funded(),c=s.campaigns[0];s.leads=s.leads.slice(0,1);applyAction(s,{type:"campaign.start",campaignId:c.id});runWorkspaceTick(s);
    const before=s.billing.balanceCents;applyAction(s,{type:"simulation.reply",leadId:s.leads[0].id,body:"詳しく知りたいです",requestId:"in1"});
    s.projects[0].monthlyBudgetCents=0;c.dailyBudgetCents=0; // Paid outreach is blocked; free conversation replies continue.
    s.now="2026-11-16T01:20:00.000Z";runWorkspaceTick(s);expect(s.billing.balanceCents).toBe(before);expect(s.conversations[0].messages).toHaveLength(3);
    applyAction(s,{type:"inbox.reply",conversationId:s.conversations[0].id,body:"承知しました。",requestId:"manual1"});
    applyAction(s,{type:"inbox.reply",conversationId:s.conversations[0].id,body:"承知しました。",requestId:"manual1"});
    expect(s.billing.balanceCents).toBe(before);expect(s.conversations[0].messages).toHaveLength(4);
  });
  test("stop freezes review; archive restores paused with auto reply off",()=>{
    const s=funded();applyAction(s,{type:"campaign.propose",projectId:s.projects[0].id});const c=s.campaigns.at(-1)!;
    expect(new Date(c.reviewEndsAt!).getTime()-new Date(s.now).getTime()).toBe(REVIEW_MS);
    s.now=new Date(new Date(s.now).getTime()+3600000).toISOString();applyAction(s,{type:"campaign.stop",campaignId:c.id});expect(c.reviewRemainingMs).toBe(REVIEW_MS-3600000);
    s.now=new Date(new Date(s.now).getTime()+86400000).toISOString();applyAction(s,{type:"campaign.start",campaignId:c.id});expect(c.status).toBe("review");
    applyAction(s,{type:"campaign.archive",campaignId:c.id});applyAction(s,{type:"campaign.restore",campaignId:c.id});expect(c.status).toBe("paused");expect(c.autoReply).toBe(false);
  });
  test("stop cancels reserved delivery; suppression holds across projects",()=>{
    const s=funded(),c=s.campaigns[0],l=s.leads[0];c.status="running";const o=reserveEmail(s,c,l,"hello","initial","one")!;
    applyAction(s,{type:"campaign.stop",campaignId:c.id});expect(o.status).toBe("cancelled");runWorkspaceTick(s);expect(c.sentCount).toBe(0);
    applyAction(s,{type:"lead.suppress",leadId:l.id});expect(s.internal.suppressions).toContain(l.email);c.status="running";expect(reserveEmail(s,c,l,"hello","initial","two")).toBeNull();
  });
  test("restart can reserve a cancelled, never-submitted initial send",()=>{
    const s=funded(),c=s.campaigns[0],l=s.leads[0];c.status="running";const out=reserveEmail(s,c,l,"hello","initial","one")!;
    applyAction(s,{type:"campaign.stop",campaignId:c.id});applyAction(s,{type:"campaign.start",campaignId:c.id});
    expect(reserveEmail(s,c,l,"hello","initial","one")).toBe(out);expect(out.status).toBe("reserved");expect(s.internal.outbox).toHaveLength(1);
  });
  test("autopilot evaluates once each UTC day and never exceeds project allocation",()=>{
    const s=funded(),p=s.projects[0],c=s.campaigns[0];p.autopilot=true;p.dailyBudgetCents=100;c.status="running";
    const other={...c,id:"other",name:"反応があるキャンペーン"};s.campaigns.push(other);s.leads.push({...s.leads[0],id:"otherlead",email:"other@example.com",campaignId:other.id,status:"interested"});
    for(let i=0;i<20;i++)s.internal.outbox.push({id:`poor${i}`,projectId:p.id,campaignId:c.id,leadId:s.leads[0].id,conversationId:null,subject:"s",body:"b",kind:"initial",status:"sent",createdAt:s.now,reservationCents:4});
    evaluateAutopilot(s);expect(String(c.status)).toBe("paused");expect(other.dailyBudgetCents).toBe(100);const count=s.activity.length;evaluateAutopilot(s);expect(s.activity.length).toBe(count);
    expect(s.campaigns.filter(c=>c.status==="running").reduce((sum,c)=>sum+c.dailyBudgetCents,0)).toBeLessThanOrEqual(p.dailyBudgetCents);
  });
  test("conversation notes survive actions without generating emails",()=>{
    const s=funded();s.leads=s.leads.slice(0,1);s.campaigns[0].status="running";runWorkspaceTick(s);const balance=s.billing.balanceCents;
    applyAction(s,{type:"inbox.note",conversationId:s.conversations[0].id,notes:"料金表を確認する"});expect(s.conversations[0].notes).toBe("料金表を確認する");expect(s.billing.balanceCents).toBe(balance);
  });
  test("incoming unsubscribe prevents auto reply and followups",()=>{
    const s=funded(),c=s.campaigns[0];s.leads=s.leads.slice(0,1);c.status="running";runWorkspaceTick(s);
    applyAction(s,{type:"simulation.reply",leadId:s.leads[0].id,body:"今後の配信停止をお願いします",requestId:"stop"});s.now="2026-11-20T01:00:00.000Z";runWorkspaceTick(s);
    expect(s.leads[0].status).toBe("suppressed");expect(c.sentCount).toBe(1);expect(s.conversations[0].pendingReply).toBeNull();
  });
  test("CSV supports BOM, quotes/newlines, duplicates and rejects malformed rows",()=>{
    const rows=parseLeadCsv('\uFEFFメールアドレス,氏名,会社名\r\nuser@example.com,"山田, 太郎","会社\n営業部"');expect(rows[0].name).toBe("山田, 太郎");expect(rows[0].company).toContain("\n");
    const s=funded();const csv="email,name\nnew@example.com,山田\nNEW@example.com,山田";applyAction(s,{type:"leads.import",projectId:s.projects[0].id,campaignId:s.campaigns[0].id,csv});expect(s.leads.filter(l=>l.email==="new@example.com")).toHaveLength(1);
    expect(()=>parseLeadCsv("email\nnot-an-email")).toThrow();expect(()=>parseLeadCsv('email,name\nuser@example.com,"open')).toThrow();
  });
  test("cross-tenant or unknown entity IDs never resolve",()=>{const a=funded(),b=funded();expect(()=>applyAction(a,{type:"campaign.stop",campaignId:b.campaigns[0].id})).toThrow("見つかりません");});
});
describe("verified billing event accounting",()=>{
  const org="00000000-0000-0000-0000-000000000001";
  test("setup retries queue only one trial and grant nothing before provider confirmation",()=>{
    const s=createWorkspace("live",monday),e={eventId:"setup:one",organizationId:org,amountCents:0,kind:"setup" as const,providerCustomerId:"cus_one"};applyBillingEvent(s,e);applyBillingEvent(s,e);
    expect(s.billing.balanceCents).toBe(0);expect(s.billing.pendingCreditCents).toBe(3000);expect(s.internal.billingJobs.filter(j=>j.kind==="trial")).toHaveLength(1);
  });
  test("only first paid topup earns promotion even when two checkouts complete",()=>{
    const s=createWorkspace("live",monday);for(const eventId of ["topup:one","topup:two"])applyBillingEvent(s,{eventId,organizationId:org,amountCents:3000,creditCents:6000,kind:"topup"});
    expect(s.billing.pendingCreditCents).toBe(9000);expect(s.billing.balanceCents).toBe(0);
  });
  test("postpaid payments settle only debt; refund notifications apply cumulative delta",()=>{
    const s=createWorkspace("live",monday);s.billing.balanceCents=-200;applyBillingEvent(s,{eventId:"paid:one",organizationId:org,amountCents:200,kind:"payment_paid"});expect(s.billing.balanceCents).toBe(0);
    for(const amountCents of [100,300,300])applyBillingEvent(s,{eventId:`refund:ch_one:${amountCents}`,refundChargeId:"ch_one",organizationId:org,amountCents,kind:"refund"});expect(s.billing.balanceCents).toBe(-300);
  });
  test("payment failure blocks all future reserved deliveries",()=>{
    const s=funded(),c=s.campaigns[0];c.status="running";const out=reserveEmail(s,c,s.leads[0],"hello","initial","one")!;
    applyBillingEvent(s,{eventId:"failed",organizationId:org,amountCents:0,kind:"payment_failed"});expect(out.status).toBe("cancelled");expect(s.billing.billingConfigured).toBe(false);
  });
});
