/** Public DTOs contain no cookie hashes, IP hashes, provider keys, or billing identities. */
export const PREVIEW_STAGES = ["company", "competitors", "campaigns", "candidates", "verification", "drafts"] as const;
export type PreviewStage = typeof PREVIEW_STAGES[number];
export type PreviewStatus = "queued" | "running" | "ready" | "failed" | "claimed";
export type PreviewSource = { title: string; url: string };
export type PreviewCompany = { name: string; website: string; business: string; customer: string; geography: string; summary: string; sources: PreviewSource[] };
export type PreviewCompetitor = { name: string; website: string; description: string; difference: string; sources: PreviewSource[] };
export type PreviewProspectCompany = { id: string; campaignId?: string; name: string; website: string; description: string; location: string; employeeCount: number | null; monthlyTraffic: number | null; trafficGrowth: number | null; sourceLabel: string };
export type PreviewCampaign = { id: string; name: string; description: string; audience: string; valueProposition: string; painPoints: string; roles: string[]; locations: string[]; companySizes: string[]; searchTerms: string[]; includeCriteria: string; excludeCriteria: string; emailInstructions: string; estimatedLeads: number | null };
export type PreviewCandidate = { id: string; campaignId: string; companyId?: string; name: string; email: string; company: string; role: string; website: string; location?: string; sourceLabel?: string; sample: boolean; verification: "sample" | "pending" | "verified" | "invalid" | "catch_all" | "unknown"; source: "sample" | "dataset"; reason: string };
export type PreviewDraft = { id: string; candidateId: string; campaignId: string; subject: string; body: string; revision: number; sample: boolean };
export type PreviewStageState = { stage: PreviewStage; status: "pending" | "running" | "completed" | "failed"; completedAt?: string };
export type PreviewState = { company: PreviewCompany | null; competitors: PreviewCompetitor[]; campaigns: PreviewCampaign[]; selectedCampaignId: string | null; companies: PreviewProspectCompany[]; candidates: PreviewCandidate[]; drafts: PreviewDraft[]; stages: PreviewStageState[]; sample: boolean; notice: string };
export type PreviewSnapshot = PreviewState & { id: string; status: PreviewStatus; revision: number; currentStage: PreviewStage | null; createdAt: string; updatedAt: string; expiresAt: string; error: { code: string; message: string; retryable: boolean } | null; claimedProjectId?: string; capabilities: { canEdit: boolean; canRetry: boolean; canClaim: boolean; canActivate: false; canCheckout: boolean } };
export type CreatePreviewInput = { website: string; business?: string; customer?: string; geography?: string };
export type PreviewAction =
  | { type: "edit_company"; company: Partial<Pick<PreviewCompany, "name" | "website" | "business" | "customer" | "geography">> }
  | { type: "edit_campaign"; campaignId: string; campaign: Partial<Pick<PreviewCampaign, "name" | "description" | "audience" | "emailInstructions" | "searchTerms" | "companySizes">> }
  | { type: "select_campaign"; campaignId: string }
  | { type: "edit_draft"; draftId: string; subject: string; body: string; to?: string }
  | { type: "retry" };
export type PatchPreviewInput = { revision: number; action: PreviewAction };
/** Unknown and catch-all are honest final provider states; only invalid/pending are blocked. */
export function usablePreviewCandidate(candidate: PreviewCandidate): boolean {
  return !candidate.sample && candidate.source === "dataset" && ["verified", "catch_all", "unknown"].includes(candidate.verification) && candidate.email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(candidate.email) && !/@(?:example\.(?:com|net|org)|[^@]*\.(?:example|invalid|test))$/i.test(candidate.email);
}
export function emptyPreviewState(): PreviewState {
  return { company: null, competitors: [], campaigns: [], selectedCampaignId: null, companies: [], candidates: [], drafts: [], stages: PREVIEW_STAGES.map(stage => ({stage,status:"pending"})), sample: true, notice: "会社・競合は公開情報から調査します。候補とメール例は架空のサンプルです。実際の送信は行いません。" };
}
