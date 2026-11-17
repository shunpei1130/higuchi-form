import { randomUUID } from "node:crypto";
import type { Activity, Campaign, CampaignTargeting, Conversation, IntegrationStates, Lead, WorkspaceSnapshot } from "./types";

export type OutboxItem = {
  id: string; projectId: string; campaignId: string; leadId: string; conversationId: string | null;
  subject: string; body: string; kind: "initial" | "followup" | "reply";
  status: "reserved" | "preparing" | "sending" | "sent" | "uncertain" | "cancelled" | "failed";
  createdAt: string; reservationCents: number; providerMessageId?: string;
  retryAt?: string;
  prepared?: boolean; preparingAt?:string; prepareAttempts?:number; generatedAt?:string;
};
export type WorkspaceState = WorkspaceSnapshot & {
  internal: { clockOffsetMs: number; processedRequests: string[]; suppressions: string[]; outbox: OutboxItem[]; providerEvents: string[]; billingJobs: BillingJob[]; refundTotals: Record<string, number>; autopilotDays:Record<string,string> };
};
export type BillingJob = { id: string; kind: "trial" | "topup" | "usage" | "configure"; status: "pending" | "running" | "complete" | "failed"; amountCents?: number; creditCents?: number; projectId?: string; campaignId?: string; messageId?: string; messageKind?: "initial" | "followup"; at: string; error?: string; attempts?:number; retryAt?:string; lockedAt?:string; firstAttemptAt?:string };
export class ProductError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "INVALID_ACTION") { super(message); }
}
export function id(_prefix: string): string { return randomUUID(); }
export function recordActivity(state: WorkspaceState, message: string, kind: Activity["kind"] = "info", projectId: string | null = state.activeProjectId): void {
  state.activity.unshift({ id: id("act"), projectId, at: state.now, message, kind });
  state.activity = state.activity.slice(0, 200);
}
export function simulationIntegrations(): IntegrationStates {
  const s = (detail: string) => ({ connected: true, status: "simulation" as const, detail });
  return { ai: s("架空の分析データを使用"), email: s("外部に送信しない検証用メール"), booking: s("検証用の予約イベント"), billing: s("実際の請求は発生しません") };
}
export function emptyIntegrations(): IntegrationStates {
  const s = (detail: string) => ({ connected: false, status: "unconfigured" as const, detail });
  return { ai: s("AI接続が必要です"), email: s("Googleメールの本人認証が必要です"), booking: s("内蔵予約ページを設定・公開してください"), billing: s("Stripeの接続が必要です") };
}
export function defaultTargeting(geography="日本"):CampaignTargeting{return {locations:geography?[geography]:[],roles:[],companySizes:[],includeCriteria:"",excludeCriteria:"連絡停止済みの宛先",valueProposition:"",painPoints:"",emailInstructions:"日本語で事実に基づいて簡潔に案内する"};}
export function createWorkspace(mode: WorkspaceSnapshot["mode"], now = new Date().toISOString()): WorkspaceState {
  const state: WorkspaceState = {
    version: 1, mode, now, activeProjectId: null, projects: [], campaigns: [], leads: [], conversations: [], meetings: [], ledger: [], activity: [],
    settings: { displayName: "", companyName: "", timezone: "Asia/Tokyo", language: "ja", bookingUrl: "", autoReply: true, emailNotifications: true },
    billing: { currency: "USD", balanceCents: 0, spentCents: 0, dailySpentCents: 0, emailPriceCents: 4, billingConfigured: false, customerId: null, paymentStatus: "unconfigured", trialClaimed: false, topupStatus: "idle", postpaidEnabled:false, firstTopupCompleted:false, pendingCreditCents:0 },
    integrations: mode === "simulation" ? simulationIntegrations() : emptyIntegrations(),
    internal: { clockOffsetMs: 0, processedRequests: [], suppressions: [], outbox: [], providerEvents: [], billingJobs: [], refundTotals:{}, autopilotDays:{} },
  };
  if (mode === "simulation") {
    const projectId = id("prj"); state.activeProjectId = projectId;
    state.projects.push({ id: projectId, name: "サンプル：Higuchi Studio", website: "https://example.com", description: "企業向けのWeb制作と業務改善を支援する架空のサービスです。", icp: "日本の中小企業の経営者・営業責任者", status: "ready", analysisSources: ["検証用サンプル"], createdAt: now, dailyBudgetCents: 500, monthlyBudgetCents: 10000, autopilot: false, geography:"日本", segments:[] });
    const campaign: Campaign = { id: id("cmp"), projectId, name: "地域企業の営業責任者", audience: "従業員10〜100名の日本企業の経営者・営業責任者", objective: "初回相談の予約", status: "paused", dailyBudgetCents: 400, emailSubject: "{{company}}様の営業活動について", emailBody: "{{name}}様\n\n{{company}}様の事業を拝見し、ご連絡しました。Higuchi Studioでは、Webを活用した新規顧客の獲得をお手伝いしています。\n\n現在の取り組みについて、15分ほどお話しできませんか。", followUpDays: [3, 7], autoReply: true, sentCount: 0, replyCount: 0, meetingCount: 0, createdAt: now, reviewEndsAt: null, reviewRemainingMs: null, upstreamCampaignId: null, language: "ja", sendWeekdays: [1, 2, 3, 4, 5], replyDelayMinutes: 15, targeting:defaultTargeting() };
    state.campaigns.push(campaign);
    for (const [i, name] of ["佐藤 花子", "鈴木 太郎", "高橋 美咲", "田中 健", "伊藤 葵", "渡辺 陸"].entries()) {
      state.leads.push({ id: id("lead"), projectId, campaignId: campaign.id, name, email: `sample${i + 1}@example.com`, company: `${["青葉", "ひかり", "みらい", "さくら", "つばさ", "こもれび"][i]}株式会社（架空）`, role: "営業責任者", website: "https://example.com", status: "ready", source: "simulation", lastContactAt: null, nextFollowUpAt: null, followUpStep: 0 });
    }
    recordActivity(state, "検証環境を準備しました。サンプルの連絡先・送信・課金はすべて架空です。", "info");
  }
  return state;
}
export function snapshot(state: WorkspaceState): WorkspaceSnapshot {
  const { internal: _internal, ...publicState } = state;
  return structuredClone(publicState);
}
/** Additive upgrades for a local file or existing aggregate created by an earlier build. */
export function normalizeWorkspaceState(state:WorkspaceState):WorkspaceState {
  const defaults=createWorkspace("live",state.now);
  state.billing={...defaults.billing,...state.billing};state.settings={...defaults.settings,...state.settings};
  state.internal={...defaults.internal,...state.internal};
  for(const p of state.projects){p.dailyBudgetCents??=500;p.monthlyBudgetCents??=10000;p.autopilot??=false;p.geography??="日本";p.segments??=[];}
  for(const c of state.campaigns){c.language??="ja";c.sendWeekdays??=[1,2,3,4,5];c.replyDelayMinutes??=15;c.targeting??=defaultTargeting(state.projects.find(p=>p.id===c.projectId)?.geography);}
  for(const t of state.conversations)t.notes??="";
  return state;
}
export function requireProject(state: WorkspaceState, projectId: string) {
  const project = state.projects.find((x) => x.id === projectId);
  if (!project) throw new ProductError("プロジェクトが見つかりません。", 404, "NOT_FOUND");
  return project;
}
export function requireCampaign(state: WorkspaceState, campaignId: string): Campaign {
  const campaign = state.campaigns.find((x) => x.id === campaignId);
  if (!campaign) throw new ProductError("キャンペーンが見つかりません。", 404, "NOT_FOUND");
  return campaign;
}
export function requireLead(state: WorkspaceState, leadId: string): Lead {
  const lead = state.leads.find((x) => x.id === leadId);
  if (!lead) throw new ProductError("連絡先が見つかりません。", 404, "NOT_FOUND");
  return lead;
}
export function requireConversation(state: WorkspaceState, conversationId: string): Conversation {
  const thread = state.conversations.find((x) => x.id === conversationId);
  if (!thread) throw new ProductError("会話が見つかりません。", 404, "NOT_FOUND");
  return thread;
}
