import type { Campaign, Conversation, Lead, WorkspaceAction } from "./types";
import { defaultTargeting, id, ProductError, recordActivity, requireCampaign, requireConversation, requireLead, requireProject, type OutboxItem, type WorkspaceState } from "./state";
import { parseLeadCsv } from "./csv";
import { latestActionableMessageId } from "./jobs/inboxRules";
import { billingPolicy } from "./money";

export const REVIEW_MS = 12 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const text = (value: unknown, label: string, max = 10000, required = false): string => {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new ProductError(`${label}を正しく入力してください。`);
  return value.trim();
};
const integer = (value: unknown, label: string, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new ProductError(`${label}は${min}〜${max}の整数で指定してください。`);
  return value;
};
const bool = (value: unknown): boolean => { if (typeof value !== "boolean") throw new ProductError("設定値が正しくありません。"); return value; };
function markRequest(state: WorkspaceState, key: string): boolean {
  text(key, "リクエストID", 300, true);
  if (state.internal.processedRequests.includes(key)) return false;
  state.internal.processedRequests.push(key); return true;
}
function safeWebsite(value: unknown): string {
  const website = text(value, "Webサイト", 2048);
  if (!website) return "";
  let url: URL; try { url = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`); } catch { throw new ProductError("WebサイトのURLを確認してください。"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new ProductError("http または https のURLを入力してください。");
  return url.toString();
}
function datePrefix(value: string, length: number) { return value.slice(0, length); }
export function refreshBilling(state: WorkspaceState): void {
  state.billing.spentCents = -state.ledger.filter((e) => e.kind === "email").reduce((sum, e) => sum + e.amountCents, 0);
  state.billing.dailySpentCents = -state.ledger.filter((e) => e.kind === "email" && datePrefix(e.at, 10) === datePrefix(state.now, 10)).reduce((sum, e) => sum + e.amountCents, 0);
}
export function canReserveEmail(state: WorkspaceState, campaign: Campaign, price = state.billing.emailPriceCents): boolean {
  if(price===0)return true; // Replies are free even when a paid outreach budget has been exhausted.
  const project = requireProject(state, campaign.projectId);
  const reservations = state.internal.outbox.filter((o) => o.status === "reserved" || o.status === "preparing" || o.status === "sending" || o.status === "uncertain");
  const available = state.billing.balanceCents - reservations.reduce((sum, o) => sum + o.reservationCents, 0);
  const spend = (projectId: string | null, campaignId: string | null, length: number) => {
    const posted = -state.ledger.filter((e) => e.kind === "email" && (!projectId || e.projectId === projectId) && (!campaignId || e.campaignId === campaignId) && datePrefix(e.at, length) === datePrefix(state.now, length)).reduce((n, e) => n + e.amountCents, 0);
    return posted + reservations.filter((o) => (!projectId || o.projectId === projectId) && (!campaignId || o.campaignId === campaignId) && datePrefix(o.createdAt, length) === datePrefix(state.now, length)).reduce((n, o) => n + o.reservationCents, 0);
  };
  const creditFloor = state.billing.postpaidEnabled && state.billing.paymentStatus === "verified" ? -billingPolicy(state.billing.currency).thresholdMinor : 0;
  return available - price >= creditFloor && spend(project.id, campaign.id, 10) + price <= campaign.dailyBudgetCents && spend(project.id, null, 10) + price <= project.dailyBudgetCents && spend(project.id, null, 7) + price <= project.monthlyBudgetCents;
}
function render(template: string, lead: Lead): string {
  return template.replace(/\{\{(name|company|email|role)\}\}/g, (_, key: "name" | "company" | "email" | "role") => lead[key] || "ご担当者");
}
export function reserveEmail(state: WorkspaceState, campaign: Campaign, lead: Lead, body: string, kind: OutboxItem["kind"], requestKey: string, conversationId: string | null = null): OutboxItem | null {
  const existing = state.internal.outbox.find((o) => o.id === requestKey);
  if (existing && existing.status !== "cancelled") return null;
  if (state.mode === "live" && !state.integrations.email.connected) return null;
  if (campaign.status !== "running" || lead.status === "suppressed" || state.internal.suppressions.includes(lead.email)) return null;
  if(kind!=="reply"&&!["ready","contacted"].includes(lead.status))return null;
  const price = kind === "reply" ? 0 : state.billing.emailPriceCents;
  if (!state.billing.billingConfigured || !canReserveEmail(state, campaign, price)) return null;
  const outgoing: OutboxItem = { id: requestKey, projectId: campaign.projectId, campaignId: campaign.id, leadId: lead.id, conversationId, subject: render(campaign.emailSubject, lead), body, kind, status: "reserved", createdAt: state.now, reservationCents: price,prepared:state.mode==="simulation"||kind==="reply" };
  if(kind==="initial"&&lead.preparedEmail){outgoing.subject=lead.preparedEmail.subject;outgoing.body=lead.preparedEmail.body;outgoing.prepared=true;outgoing.generatedAt=state.now;}
  if(existing){Object.assign(existing,outgoing);return existing;}
  state.internal.outbox.push(outgoing);return outgoing;
}
export function confirmEmail(state: WorkspaceState, outgoing: OutboxItem, providerMessageId?: string, acceptedAt?:string): void {
  if (outgoing.status === "sent") return;
  const deliveredAt=acceptedAt&&Number.isFinite(Date.parse(acceptedAt))?new Date(acceptedAt).toISOString():state.now;
  const campaign = requireCampaign(state, outgoing.campaignId), lead = requireLead(state, outgoing.leadId);
  outgoing.status = "sent"; outgoing.providerMessageId = providerMessageId;
  if (outgoing.reservationCents > 0 && !state.ledger.some((e) => e.dedupeKey === outgoing.id)) {
    state.ledger.unshift({ id: id("entry"), projectId: outgoing.projectId, campaignId: campaign.id, at: deliveredAt, kind: "email", currency:state.billing.currency,priceVersion:state.billing.priceVersion,amountCents: -outgoing.reservationCents, description: `${lead.company || lead.name || lead.email}への${outgoing.kind === "reply" ? "返信" : outgoing.kind === "followup" ? "フォローアップ" : "初回メール"}`, dedupeKey: outgoing.id });
    state.billing.balanceCents -= outgoing.reservationCents;
  }
  campaign.sentCount++;
  let thread = outgoing.conversationId ? state.conversations.find((x) => x.id === outgoing.conversationId) : state.conversations.find((x) => x.leadId === lead.id && x.campaignId === campaign.id);
  if (!thread) { thread = { id: id("thread"), projectId: campaign.projectId, campaignId: campaign.id, leadId: lead.id, subject: outgoing.subject, unread: false, status: "active", messages: [], autoReplyAt: null, pendingReply: null, notes:"" }; state.conversations.push(thread); }
  thread.messages.push({ id: outgoing.id, body: outgoing.body, direction: "outbound", automatic: !outgoing.id.startsWith("manual:"), sentAt: deliveredAt, status: state.mode === "simulation" ? "simulated" : "sent" });
  if (outgoing.kind === "reply") { thread.pendingReply = null; thread.autoReplyAt = null; }
  else {
    if (lead.status === "ready") lead.status = "contacted";
    lead.lastContactAt = deliveredAt;
    if (outgoing.kind === "followup") lead.followUpStep++;
    const delay = campaign.followUpDays[lead.followUpStep];
    lead.nextFollowUpAt = delay === undefined ? null : new Date(new Date(deliveredAt).getTime() + delay * DAY).toISOString();
  }
  refreshBilling(state);
  recordActivity(state, `${lead.company || lead.email}へ${state.mode === "simulation" ? "検証メールを記録" : "メールを送信"}しました。`, "success", campaign.projectId);
}
function cancelPending(state: WorkspaceState, campaign: Campaign): void {
  for (const o of state.internal.outbox) if (o.campaignId === campaign.id && (o.status === "reserved"||o.status === "preparing")) o.status = "cancelled";
}
export function suppressLead(state: WorkspaceState, lead: Lead): void {
  if (!state.internal.suppressions.includes(lead.email)) state.internal.suppressions.push(lead.email);
  for (const l of state.leads) if (l.email === lead.email) { l.status = "suppressed"; l.nextFollowUpAt = null; }
  for (const t of state.conversations) if (state.leads.find((l) => l.id === t.leadId)?.email === lead.email) { t.status = "suppressed"; t.pendingReply = null; t.autoReplyAt = null; }
  for (const o of state.internal.outbox) if (state.leads.find((l) => l.id === o.leadId)?.email === lead.email && (o.status === "reserved"||o.status === "preparing")) o.status = "cancelled";
  recordActivity(state, `${lead.email}への連絡を停止しました。`, "warning", lead.projectId);
}
/** Conservative, explicit policy; Explee's private optimization algorithm is not public. */
export function evaluateAutopilot(state:WorkspaceState):void {
  state.internal.autopilotDays??={};const day=state.now.slice(0,10);
  for(const project of state.projects.filter(p=>p.autopilot)){
    if(state.internal.autopilotDays[project.id]===day)continue;state.internal.autopilotDays[project.id]=day;
    const campaigns=state.campaigns.filter(c=>c.projectId===project.id&&c.status==="running");let stopped=0;
    const stats=(c:Campaign)=>{
      const sent=state.internal.outbox.filter(o=>o.campaignId===c.id&&o.status==="sent"&&o.kind!=="reply").length;
      const replied=state.leads.filter(l=>l.campaignId===c.id&&["replied","interested","booked"].includes(l.status)).length;
      const interested=state.leads.filter(l=>l.campaignId===c.id&&["interested","booked"].includes(l.status)).length;
      return {sent,replied,interested};
    };
    for(const c of campaigns){const s=stats(c);if(s.sent>=20&&s.replied/s.sent<0.02&&c.meetingCount===0){c.status="paused";cancelPending(state,c);stopped++;}}
    const eligible=campaigns.filter(c=>c.status==="running"&&state.leads.some(l=>l.campaignId===c.id&&l.status!=="suppressed")).sort((a,b)=>a.id.localeCompare(b.id));
    const weights=eligible.map(c=>{const s=stats(c);return (1+s.replied+s.interested*2+c.meetingCount*5)/(20+s.sent);});
    const total=weights.reduce((a,b)=>a+b,0);let assigned=0;
    for(let i=0;i<eligible.length;i++){const allocation=i===eligible.length-1?project.dailyBudgetCents-assigned:Math.floor(project.dailyBudgetCents*weights[i]/total);eligible[i].dailyBudgetCents=Math.max(0,allocation);assigned+=allocation;}
    recordActivity(state,`UTC日次評価を実施しました。稼働${eligible.length}件に日次予算を配分${stopped?`し、20通以上送信して返信率2%未満の${stopped}件を停止`:""}しました。`,"info",project.id);
  }
}
export function runWorkspaceTick(state: WorkspaceState): void {
  evaluateAutopilot(state);
  const now = new Date(state.now).getTime();
  for (const campaign of state.campaigns) {
    if (campaign.status === "review" && campaign.reviewEndsAt && new Date(campaign.reviewEndsAt).getTime() <= now) { campaign.status = "running"; campaign.reviewEndsAt = null; recordActivity(state, `${campaign.name}のレビュー期間が終了し、開始しました。`, "success", campaign.projectId); }
    if (campaign.status !== "running") continue;
    const weekday = Number(new Intl.DateTimeFormat("en-US", { timeZone: state.settings.timezone, weekday: "short" }).format(new Date(state.now)).replace(/Sun|Mon|Tue|Wed|Thu|Fri|Sat/g, (s) => String(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(s))));
    if (!campaign.sendWeekdays.includes(weekday)) continue;
    let queued = 0;
    for (const thread of state.conversations.filter((t) => t.campaignId === campaign.id && t.pendingReply && t.autoReplyAt && new Date(t.autoReplyAt).getTime() <= now)) {
      if (!campaign.autoReply || !state.settings.autoReply) continue;
      const lead = requireLead(state, thread.leadId);
      const out = reserveEmail(state, campaign, lead, thread.pendingReply!, "reply", `autoreply:${thread.id}:${latestActionableMessageId(thread)}`, thread.id);
      if (out && state.mode === "simulation") confirmEmail(state, out);
    }
    for (const lead of state.leads.filter((l) => l.campaignId === campaign.id)) {
      if (queued >= 5 || !["ready", "contacted"].includes(lead.status)) continue;
      const initial = lead.status === "ready";
      if (!initial && (!lead.nextFollowUpAt || new Date(lead.nextFollowUpAt).getTime() > now)) continue;
      const body = initial ? render(campaign.emailBody, lead) : `${lead.name || "ご担当者"}様\n\n先日のご連絡について、その後いかがでしょうか。${campaign.objective}について、ご関心がございましたらお知らせください。`;
      const out = reserveEmail(state, campaign, lead, body, initial ? "initial" : "followup", `${campaign.id}:${lead.id}:${initial ? "initial" : `followup:${lead.followUpStep}`}`);
      if (out) { queued++; if (state.mode === "simulation") confirmEmail(state, out); }
    }
  }
}
export function applyAction(state: WorkspaceState, action: WorkspaceAction): void {
  delete state.notice; delete state.redirectUrl;
  switch (action.type) {
    case "project.create": {
      const project = { id: id("prj"), name: text(action.name, "サービス名", 200, true), website: safeWebsite(action.website ?? ""), description: text(action.description ?? "", "事業内容"), icp: text(action.icp ?? "", "理想の顧客"), createdAt: state.now, status: (state.mode === "simulation" ? "ready" : "needs_setup") as "ready" | "needs_setup", analysisSources: [] as string[], dailyBudgetCents: billingPolicy(state.billing.currency).defaultDailyMinor, monthlyBudgetCents: billingPolicy(state.billing.currency).defaultMonthlyMinor, autopilot: false, geography:text(action.geography??"日本","対象地域",1000), segments:[] };
      if (!project.website && !project.description) throw new ProductError("Webサイトまたは事業内容を入力してください。");
      state.projects.push(project); state.activeProjectId = project.id; recordActivity(state, `${project.name}を作成しました。`); break;
    }
    case "project.select": requireProject(state, action.projectId); state.activeProjectId = action.projectId; break;
    case "project.update": {
      const p = requireProject(state, action.projectId);
      for (const key of ["name", "description", "icp"] as const) if (action[key] !== undefined) p[key] = text(action[key], key, key === "name" ? 200 : 10000, key === "name");
      if (action.website !== undefined) p.website = safeWebsite(action.website);
      if (action.geography !== undefined) p.geography = text(action.geography,"対象地域",1000);
      if (action.dailyBudgetCents !== undefined) p.dailyBudgetCents = integer(action.dailyBudgetCents, "日次予算", 0, 1000000);
      if (action.monthlyBudgetCents !== undefined) p.monthlyBudgetCents = integer(action.monthlyBudgetCents, "月次予算", 0, 10000000);
      if (action.autopilot !== undefined) p.autopilot = bool(action.autopilot);
      recordActivity(state, "プロジェクト設定を保存しました。"); break;
    }
    case "campaign.propose": {
      const p = requireProject(state, action.projectId);
      const segmentIndex=integer(action.segmentIndex??0,"顧客セグメント",0,2),segment=p.segments[segmentIndex];
      const {name:_segmentName,...targeting}=segment??{name:"",...defaultTargeting(p.geography)};
      state.campaigns.push({ id: id("cmp"), projectId: p.id, name: text(action.name ?? segment?.name ?? `${p.name}の新規開拓`, "キャンペーン名", 200, true), audience: text(action.audience ?? segment?.includeCriteria ?? p.icp, "対象顧客"), objective: text(action.objective ?? "初回相談の予約", "目的", 500), status: "review", dailyBudgetCents: Math.min(billingPolicy(state.billing.currency).defaultCampaignMinor, p.dailyBudgetCents), emailSubject: `${p.name}からのご相談`, emailBody: `{{name}}様\n\n{{company}}様の事業について、お話しできればと考えご連絡しました。\n\n${p.description}\n\nご関心がございましたら、短いお打ち合わせのお時間をいただけますか。`, followUpDays: [3, 7], autoReply: true, sentCount: 0, replyCount: 0, meetingCount: 0, createdAt: state.now, reviewEndsAt: new Date(new Date(state.now).getTime() + REVIEW_MS).toISOString(), reviewRemainingMs: null, upstreamCampaignId: null, language: "ja", sendWeekdays: [1,2,3,4,5], replyDelayMinutes: 15, targeting });
      recordActivity(state, "キャンペーン案を作成しました。12時間のレビュー期間後に開始します。", "info", p.id); break;
    }
    case "campaign.update": {
      const c = requireCampaign(state, action.campaignId);
      if (c.status === "archived") throw new ProductError("編集するにはアーカイブから復元してください。", 409);
      if(action.emailSubject!==undefined||action.emailBody!==undefined)for(const lead of state.leads)if(lead.campaignId===c.id)delete lead.preparedEmail;
      for (const key of ["name", "audience", "objective", "emailSubject", "emailBody"] as const) if (action[key] !== undefined) c[key] = text(action[key], key, key === "emailBody" ? 30000 : 10000, key === "name" || key === "emailBody" || key === "emailSubject");
      if (action.dailyBudgetCents !== undefined) c.dailyBudgetCents = integer(action.dailyBudgetCents, "日次予算", 0, 1000000);
      if (action.autoReply !== undefined) c.autoReply = bool(action.autoReply);
      if(action.targeting){
        for(const key of ["locations","roles","companySizes"] as const)if(action.targeting[key]!==undefined){const values=action.targeting[key];if(!Array.isArray(values)||values.length>50)throw new ProductError("対象条件の形式を確認してください。");c.targeting[key]=values.map(v=>text(v,"対象条件",300));}
        for(const key of ["includeCriteria","excludeCriteria","valueProposition","painPoints","emailInstructions"] as const)if(action.targeting[key]!==undefined)c.targeting[key]=text(action.targeting[key],"対象条件",5000);
      }
      if (action.replyDelayMinutes !== undefined) c.replyDelayMinutes = integer(action.replyDelayMinutes, "返信待機時間", 0, 1440);
      if (action.followUpDays !== undefined) { if (!Array.isArray(action.followUpDays) || action.followUpDays.length > 5) throw new ProductError("追客は5回以内で指定してください。"); c.followUpDays = action.followUpDays.map((n) => integer(n, "追客日数", 1, 90)); }
      if (action.sendWeekdays !== undefined) { if (!Array.isArray(action.sendWeekdays) || !action.sendWeekdays.length || action.sendWeekdays.length > 7) throw new ProductError("送信曜日を選択してください。"); c.sendWeekdays = [...new Set(action.sendWeekdays.map((n) => integer(n, "送信曜日", 0, 6)))]; }
      recordActivity(state, "キャンペーンを保存しました。", "success", c.projectId); break;
    }
    case "campaign.start": case "campaign.approve": {
      const c = requireCampaign(state, action.campaignId); if (c.status === "archived") throw new ProductError("先にキャンペーンを復元してください。", 409);
      if (state.mode === "live" && !state.integrations.email.connected) throw new ProductError("送信アカウントが未設定です。運営者に割当を依頼してください。", 409, "EMAIL_UNCONFIGURED");
      if (state.mode === "live" && !state.integrations.ai.connected) throw new ProductError("AI接続が未設定です。運営者に設定を依頼してください。",409,"AI_UNCONFIGURED");
      if (!state.billing.billingConfigured) throw new ProductError("先に決済設定を完了してください。", 409, "BILLING_REQUIRED");
      if (action.type === "campaign.start" && c.reviewRemainingMs !== null && c.reviewRemainingMs > 0) { c.status = "review"; c.reviewEndsAt = new Date(new Date(state.now).getTime() + c.reviewRemainingMs).toISOString(); }
      else if (action.type === "campaign.start" && c.status === "review") { /* Preserve active review. */ }
      else { c.status = "running"; c.reviewEndsAt = null; c.reviewRemainingMs = null; }
      recordActivity(state, `${c.name}を${c.status === "review" ? "レビューに戻し" : "開始し"}ました。`, "success", c.projectId); break;
    }
    case "campaign.stop": case "campaign.archive": case "campaign.restore": {
      const c = requireCampaign(state, action.campaignId);
      if(c.status === "archived" && action.type === "campaign.stop")throw new ProductError("アーカイブから復元してから操作してください。",409);
      if (action.type === "campaign.restore") { if (c.status !== "archived") throw new ProductError("アーカイブされていません。", 409); c.status = "paused"; c.autoReply = false; }
      else { if (c.status === "review" && c.reviewEndsAt) c.reviewRemainingMs = Math.max(0, new Date(c.reviewEndsAt).getTime() - new Date(state.now).getTime()); c.reviewEndsAt = null; c.status = action.type === "campaign.archive" ? "archived" : "paused"; cancelPending(state, c); if (c.status === "archived") { c.autoReply = false; for (const t of state.conversations.filter((t) => t.campaignId === c.id)) { t.autoReplyAt = null; t.pendingReply = null; } } }
      recordActivity(state, `${c.name}を${action.type === "campaign.archive" ? "アーカイブ" : action.type === "campaign.restore" ? "復元" : "停止"}しました。`, "info", c.projectId); break;
    }
    case "leads.import": {
      requireProject(state, action.projectId); const campaign = action.campaignId ? requireCampaign(state, action.campaignId) : null;
      if (campaign && campaign.projectId !== action.projectId) throw new ProductError("キャンペーンが見つかりません。", 404);
      const rows = parseLeadCsv(action.csv); let added = 0, duplicate = 0;
      for (const row of rows) { const existing = state.leads.find((l) => l.projectId === action.projectId && l.email === row.email); if (existing) { if (campaign && !existing.campaignId) existing.campaignId = campaign.id; duplicate++; continue; } state.leads.push({ ...row, id: id("lead"), projectId: action.projectId, campaignId: campaign?.id ?? null, status: state.internal.suppressions.includes(row.email) ? "suppressed" : "ready", source: "csv", lastContactAt: null, nextFollowUpAt: null, followUpStep: 0 }); added++; }
      if (campaign && campaign.status === "review") { campaign.status = "paused"; campaign.reviewEndsAt = null; campaign.reviewRemainingMs = null; }
      state.notice = `${added}件を取り込みました。重複${duplicate}件は追加していません。`; recordActivity(state, state.notice, "success", action.projectId); break;
    }
    case "lead.suppress": suppressLead(state, requireLead(state, action.leadId)); break;
    case "inbox.read": requireConversation(state, action.conversationId).unread = false; break;
    case "inbox.note": requireConversation(state, action.conversationId).notes = text(action.notes,"メモ",10000); break;
    case "inbox.suppress": suppressLead(state, requireLead(state, requireConversation(state, action.conversationId).leadId)); break;
    case "inbox.reply": {
      const thread = requireConversation(state, action.conversationId), lead = requireLead(state, thread.leadId), c = requireCampaign(state, thread.campaignId); const body = text(action.body, "返信", 30000, true);
      if (!markRequest(state, `reply:${action.requestId}`)) break;
      if (lead.status === "suppressed") throw new ProductError("連絡停止済みの相手には送信できません。", 409);
      if (c.status !== "running") throw new ProductError("返信するにはキャンペーンを開始してください。", 409);
      const outgoing = reserveEmail(state, c, lead, body, "reply", `manual:${action.requestId}`, thread.id);
      if (!outgoing) throw new ProductError("クレジット残高または予算を確認してください。", 409, "BUDGET_EXCEEDED");
      thread.pendingReply=null;thread.autoReplyAt=null;
      for(const queued of state.internal.outbox)if(queued.id!==outgoing.id&&queued.conversationId===thread.id&&queued.kind==="reply"&&queued.id.startsWith("autoreply:")&&["reserved","preparing"].includes(queued.status))queued.status="cancelled";
      if (state.mode === "simulation") confirmEmail(state, outgoing); thread.unread = false; break;
    }
    case "settings.update": {
      const input = action.settings; if (!input || typeof input !== "object") throw new ProductError("設定値が正しくありません。");
      for (const key of ["displayName", "companyName"] as const) if (input[key] !== undefined) state.settings[key] = text(input[key], key, 300);
      if (input.bookingUrl !== undefined) { const url = safeWebsite(input.bookingUrl); if (url && new URL(url).hostname !== "cal.com") throw new ProductError("Cal.comの予約URLを指定してください。"); state.settings.bookingUrl = url; }
      if (input.timezone !== undefined) { const zone = text(input.timezone, "タイムゾーン", 100); try { new Intl.DateTimeFormat("ja", { timeZone: zone }); } catch { throw new ProductError("タイムゾーンを確認してください。"); } state.settings.timezone = zone; }
      if (input.autoReply !== undefined) state.settings.autoReply = bool(input.autoReply); if (input.emailNotifications !== undefined) state.settings.emailNotifications = bool(input.emailNotifications);
      recordActivity(state, "設定を保存しました。", "success"); break;
    }
    case "billing.verify": {
      if (state.mode !== "simulation") throw new ProductError("本番環境では決済サービスでカードを確認してください。", 409);
      if (!markRequest(state, `verify:${action.requestId}`)) break;
      state.billing.billingConfigured = true; state.billing.paymentStatus = "verified"; state.billing.postpaidEnabled=true;
      if (!state.billing.trialClaimed&&!state.billing.firstTopupCompleted) { state.billing.trialClaimed = true; state.billing.balanceCents += billingPolicy(state.billing.currency).trialMinor; state.ledger.unshift({ id: id("entry"), projectId: null, campaignId: null, kind: "trial", amountCents: billingPolicy(state.billing.currency).trialMinor, currency:state.billing.currency,priceVersion:state.billing.priceVersion,at: state.now, description: "カード確認をシミュレート：無料クレジット", dedupeKey: "simulation-trial" }); }
      recordActivity(state, "カード確認をシミュレートしました。実際の請求は発生していません。", "success"); break;
    }
    case "billing.topup": {
      if (state.mode !== "simulation") throw new ProductError("本番環境では決済画面から入金してください。", 409);
      const amount = integer(action.amountCents, "入金額", 1, 15000); if (!(billingPolicy(state.billing.currency).topupMinor as readonly number[]).includes(amount)) throw new ProductError("指定できない前払い金額です。");
      if (!markRequest(state, `topup:${action.requestId}`)) break;
      const credit = state.billing.firstTopupCompleted||state.billing.trialClaimed ? amount : amount*2; state.billing.firstTopupCompleted=true;state.billing.billingConfigured=true;state.billing.paymentStatus="verified";state.billing.postpaidEnabled=true;
      state.billing.balanceCents += credit; state.billing.topupStatus = "completed"; state.ledger.unshift({ id: id("entry"), projectId: null, campaignId: null, at: state.now, kind: "topup", currency:state.billing.currency,priceVersion:state.billing.priceVersion,amountCents: credit, description: `検証用クレジットの追加${credit>amount?"（初回特典2倍）":""}：実際の請求なし`, dedupeKey: `topup:${action.requestId}` }); recordActivity(state, "検証用クレジットを追加しました。", "success"); break;
    }
    case "simulation.reply": {
      if (state.mode !== "simulation") throw new ProductError("検証操作は本番環境では使用できません。", 403);
      const lead = requireLead(state, action.leadId), body = text(action.body, "返信内容", 30000, true); if (!lead.campaignId) throw new ProductError("キャンペーンに所属していない連絡先です。");
      if (!markRequest(state, `inbound:${action.requestId}`)) break;
      const c = requireCampaign(state, lead.campaignId); let thread = state.conversations.find((t) => t.leadId === lead.id && t.campaignId === c.id);
      if (!thread) { thread = { id: id("thread"), projectId: lead.projectId, campaignId: c.id, leadId: lead.id, subject: c.emailSubject, unread: false, status: "active", messages: [], autoReplyAt: null, pendingReply: null, notes:"" }; state.conversations.push(thread); }
      thread.messages.push({ id: `inbound:${action.requestId}`, direction: "inbound", body, sentAt: state.now, automatic: false, status: "received" }); thread.unread = true; c.replyCount++; lead.nextFollowUpAt = null;
      if (/配信停止|送信停止|連絡不要|連絡しない|unsubscribe|stop emailing/i.test(body)) { suppressLead(state, lead); break; }
      if (lead.status === "suppressed") break;
      const interested = /興味|詳しく|料金|相談|打ち合わせ|日程|資料|予約/.test(body); lead.status = interested ? "interested" : "replied"; thread.status = interested ? "interested" : "active";
      thread.pendingReply = `ご返信ありがとうございます。${state.settings.bookingUrl ? `以下のページからご都合のよい日時をお選びください。\n${state.settings.bookingUrl}` : "ご関心をお寄せいただきありがとうございます。ご都合のよい日時をお知らせいただけますか。"}`;
      thread.autoReplyAt = new Date(new Date(state.now).getTime() + c.replyDelayMinutes * 60000).toISOString();
      for (const o of state.internal.outbox) if (o.leadId === lead.id && (o.status === "reserved"||o.status === "preparing")) o.status = "cancelled";
      recordActivity(state, `${lead.name || lead.email}からの返信を記録しました。`, "success", lead.projectId); break;
    }
    case "simulation.booking": {
      if (state.mode !== "simulation") throw new ProductError("検証操作は本番環境では使用できません。", 403);
      const lead = requireLead(state, action.leadId); if (!lead.campaignId) throw new ProductError("キャンペーンに所属していない連絡先です。");
      const startsAt = new Date(text(action.startsAt, "予約日時", 100, true)); if (!Number.isFinite(startsAt.getTime()) || startsAt.getTime() <= new Date(state.now).getTime()) throw new ProductError("未来の予約日時を指定してください。");
      if (!markRequest(state, `booking:${action.requestId}`)) break;
      if (lead.status === "suppressed") throw new ProductError("連絡停止済みの相手です。", 409);
      state.meetings.push({ id: id("meeting"), projectId: lead.projectId, campaignId: lead.campaignId, leadId: lead.id, startsAt: startsAt.toISOString(), status: "booked", provider: "simulation" }); lead.status = "booked"; lead.nextFollowUpAt = null; requireCampaign(state, lead.campaignId).meetingCount++;
      for (const t of state.conversations.filter((t) => t.leadId === lead.id)) { t.status = "booked"; t.autoReplyAt = null; t.pendingReply = null; } recordActivity(state, `${lead.name || lead.email}の予約を記録しました。`, "success", lead.projectId); break;
    }
    case "simulation.tick": {
      if (state.mode !== "simulation") throw new ProductError("検証操作は本番環境では使用できません。", 403);
      const minutes = integer(action.advanceMinutes ?? 0, "経過時間", 0, 43200); state.internal.clockOffsetMs += minutes * 60000; state.now = new Date(new Date(state.now).getTime() + minutes * 60000).toISOString(); runWorkspaceTick(state); break;
    }
    case "simulation.reset": throw new ProductError("リセットは専用の処理で実行してください。");
    case "billing.setup": case "billing.checkout": case "billing.portal": throw new ProductError("決済サービスの接続が必要です。", 409);
    default: throw new ProductError("対応していない操作です。");
  }
  refreshBilling(state);
}
