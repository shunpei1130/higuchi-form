import type { MoneyCurrency } from "./money";
/** Client contract. Deprecated *Cents names contain integer minor units for billing.currency. */
export type ProductMode = "simulation" | "live";
export type CampaignStatus = "draft" | "review" | "running" | "paused" | "archived";
export type LeadStatus = "ready" | "contacted" | "replied" | "interested" | "booked" | "suppressed";
export type ProjectSegment={name:string;valueProposition:string;painPoints:string;roles:string[];locations:string[];companySizes:string[];includeCriteria:string;excludeCriteria:string;emailInstructions:string};
export type CampaignTargeting=Omit<ProjectSegment,"name">;
export type Project = {
  id: string; name: string; website: string; description: string; icp: string;
  createdAt: string; status: "ready" | "analyzing" | "needs_setup"; analysisSources: string[];
  dailyBudgetCents: number; monthlyBudgetCents: number; autopilot: boolean;
  geography: string; segments: ProjectSegment[]; previewRunId?: string;
};
export type Campaign = {
  id: string; projectId: string; name: string; audience: string; objective: string;
  status: CampaignStatus; dailyBudgetCents: number; emailSubject: string; emailBody: string;
  followUpDays: number[]; autoReply: boolean; sentCount: number; replyCount: number;
  meetingCount: number; createdAt: string; reviewEndsAt: string | null;
  reviewRemainingMs: number | null; upstreamCampaignId: string | null;
  language: "ja"; sendWeekdays: number[]; replyDelayMinutes: number;
  targeting: CampaignTargeting;
};
export type Lead = {
  id: string; projectId: string; campaignId: string | null; name: string; email: string;
  company: string; role: string; website: string; status: LeadStatus; source: "csv" | "simulation" | "dataset";
  preparedEmail?: {subject:string;body:string;revision:number};
  lastContactAt: string | null; nextFollowUpAt: string | null; followUpStep: number;
};
export type InboxMessage = { id: string; direction: "inbound" | "outbound"; body: string; sentAt: string; automatic: boolean; status: "sent" | "received" | "simulated" };
export type Conversation = {
  id: string; projectId: string; campaignId: string; leadId: string; subject: string;
  unread: boolean; status: "active" | "interested" | "booked" | "suppressed";
  messages: InboxMessage[]; autoReplyAt: string | null; pendingReply: string | null;
  notes: string;
  providerThreadId?: string;
};
export type Meeting = { id: string; projectId: string; campaignId: string; leadId: string; startsAt: string; endsAt?:string; status: "booked" | "cancelled"; provider: "calcom" | "simulation" | "internal" };
export type LedgerEntry = {
  id: string; projectId: string | null; campaignId: string | null; at: string;
  kind: "trial" | "topup" | "email" | "refund"; amountCents: number;
  description: string; dedupeKey: string; currency?: MoneyCurrency; priceVersion?: string;
};
export type Activity = { id: string; projectId: string | null; at: string; message: string; kind: "info" | "success" | "warning" };
export type WorkspaceSettings = {
  displayName: string; companyName: string; timezone: string; language: "ja";
  bookingUrl: string; autoReply: boolean; emailNotifications: boolean;
};
export type BillingState = {
  currency: MoneyCurrency; priceVersion?: string; balanceCents: number; spentCents: number; dailySpentCents: number;
  emailPriceCents: number; billingConfigured: boolean; customerId: string | null;
  paymentStatus: "unconfigured" | "pending" | "verified" | "failed";
  trialClaimed: boolean; topupStatus: "idle" | "pending" | "completed" | "failed";
  postpaidEnabled: boolean; firstTopupCompleted: boolean; pendingCreditCents: number;
  subscriptionId?:string; lastProviderEventCreatedAt?:number;
  reconciliationRequired?:boolean;
  firstPrepayment?: { sessionId: string; paymentIntentId?: string; chargeId?: string; amountMinor: number; currency: MoneyCurrency; priceVersion: string; purchasedAt: string };
  verifiedPreviewSessions?: Record<string,{sessionId:string;mode:"setup"|"payment";amountMinor:number;currency:MoneyCurrency;verifiedAt:string}>;
  pendingPreviewSessions?: Record<string,{sessionId:string;mode:"setup"|"payment";amountMinor:number;currency:MoneyCurrency;requestId?:string;returnUrl?:string;createdAt?:string;firstPaymentBonus?:boolean;lockId?:string;leaseUntil?:string}>;
};
export type ConnectionState = { connected: boolean; status: "ready" | "unconfigured" | "simulation"; detail: string };
export type IntegrationStates = { ai: ConnectionState; email: ConnectionState; booking: ConnectionState; billing: ConnectionState };
export type WorkspaceSnapshot = {
  version: 1; mode: ProductMode; now: string; activeProjectId: string | null;
  projects: Project[]; campaigns: Campaign[]; leads: Lead[]; conversations: Conversation[];
  meetings: Meeting[]; ledger: LedgerEntry[]; activity: Activity[];
  settings: WorkspaceSettings; billing: BillingState; integrations: IntegrationStates;
  notice?: string; redirectUrl?: string;
};
export type WorkspaceAction =
  | { type: "project.create"; name: string; website?: string; description?: string; icp?: string; geography?:string }
  | { type: "project.update"; projectId: string; name?: string; description?: string; icp?: string; website?: string; dailyBudgetCents?: number; monthlyBudgetCents?: number; autopilot?: boolean; geography?:string }
  | { type: "project.select"; projectId: string }
  | { type: "campaign.propose"; projectId: string; name?: string; audience?: string; objective?: string; segmentIndex?:number }
  | { type: "campaign.update"; campaignId: string; name?: string; audience?: string; objective?: string; dailyBudgetCents?: number; emailSubject?: string; emailBody?: string; autoReply?: boolean; followUpDays?: number[]; sendWeekdays?: number[]; replyDelayMinutes?: number; targeting?:Partial<CampaignTargeting> }
  | { type: "campaign.start" | "campaign.stop" | "campaign.archive" | "campaign.restore" | "campaign.approve"; campaignId: string }
  | { type: "leads.import"; projectId: string; campaignId?: string; csv: string }
  | { type: "inbox.read" | "inbox.suppress"; conversationId: string }
  | { type: "inbox.reply"; conversationId: string; body: string; requestId: string }
  | { type: "inbox.note"; conversationId: string; notes: string }
  | { type: "lead.suppress"; leadId: string }
  | { type: "settings.update"; settings: Partial<WorkspaceSettings> }
  | { type: "billing.topup"; amountCents: number; requestId: string }
  | { type: "billing.verify"; requestId: string }
  | { type: "billing.setup"; requestId: string }
  | { type: "billing.checkout"; amountCents: number; requestId: string }
  | { type: "billing.portal"; requestId: string }
  | { type: "simulation.tick"; advanceMinutes?: number }
  | { type: "simulation.reply"; leadId: string; body: string; requestId: string }
  | { type: "simulation.booking"; leadId: string; startsAt: string; requestId: string }
  | { type: "simulation.reset" };
