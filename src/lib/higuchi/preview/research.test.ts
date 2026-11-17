import { afterEach, beforeEach, expect, test } from "bun:test";
import { catalogCandidates, executePreviewStage, sampleCandidates, selectDraftCandidates, type ResearchDependencies } from "./research";
import { emptyPreviewState, type PreviewCampaign, type PreviewState } from "./types";
import type { PreviewRun } from "./store";

const fixture = process.env.HIGUCHI_PREVIEW_FIXTURE;
beforeEach(() => { delete process.env.HIGUCHI_PREVIEW_FIXTURE; });
afterEach(() => { if (fixture === undefined) delete process.env.HIGUCHI_PREVIEW_FIXTURE; else process.env.HIGUCHI_PREVIEW_FIXTURE = fixture; });
const campaigns = (): PreviewCampaign[] => Array.from({ length: 6 }, (_, i) => ({ id: `campaign-${i}`, name: `施策${i}`, description: "業務改善の提案", audience: "日本の製造業の担当者", valueProposition: "作業を整理", painPoints: "手作業", roles: ["代表"], locations: ["JP"], companySizes: ["10-100"], searchTerms: [`業種${i}`, `industry${i}`], includeCriteria: "対象企業", excludeCriteria: "対象外", emailInstructions: "短く", estimatedLeads: null }));
function state(): PreviewState { return { ...emptyPreviewState(), company: { name: "提供会社", website: "https://seller.example/", business: "業務改善", customer: "従業員10〜100名で営業部門の業務改善に取り組む日本の製造業企業の意思決定者", geography: "日本", summary: "事業内容", sources: [] }, campaigns: campaigns(), selectedCampaignId: "campaign-5" }; }
function run(stageIndex: number, preview = state()): PreviewRun { return { id: "00000000-0000-4000-8000-000000000001", generation: 0, stageIndex, state: preview, input: { website: "https://seller.example/" } } as PreviewRun; }
const catalog = { available: true, datasetRevision: "v1", companies: [{ id: "company-one", name: "提供データの会社", domain: "prospect.co.jp", description: "製造業", location: "Tokyo, Japan", employeeCount: 42, monthlyTraffic: null, trafficGrowth: null, sourceUrl: "" }], people: [{ id: "person-one", companyId: "company-one", name: "担当者", role: "CEO", email: "contact@prospect.co.jp", verification: "unknown" as const, location: "JP", sourceUrl: "", sourceLabel: "Excel" }] };

test("all six campaigns receive a draft slot and the selected campaign is first", () => {
  const preview = state(); Object.assign(preview, sampleCandidates(preview.campaigns));
  expect(preview.candidates).toHaveLength(18);
  const selected = selectDraftCandidates(preview);
  expect(selected).toHaveLength(9);
  expect(selected[0].campaignId).toBe("campaign-5");
  expect(new Set(selected.slice(0, 6).map(candidate => candidate.campaignId)).size).toBe(6);
  expect(selected.filter(candidate => candidate.campaignId === "campaign-5")).toHaveLength(2);
});

test("campaign-scoped mappings never collide when the same person matches two campaigns", () => {
  const mapped = catalogCandidates(catalog, campaigns());
  expect(new Set(mapped.candidates.map(candidate => candidate.id)).size).toBe(6);
  expect(new Set(mapped.companies.map(company => company.id)).size).toBe(6);
  for (const candidate of mapped.candidates) expect(mapped.companies.find(company => company.id === candidate.companyId)?.campaignId).toBe(candidate.campaignId);
});

test("each campaign searches short keywords, geography, role and company size independently", async () => {
  const inputs: Parameters<ResearchDependencies["catalog"]>[0][] = [];
  const result = await executePreviewStage(run(3), { catalog: async input => { inputs.push(input); return catalog; } });
  expect(inputs).toHaveLength(6);
  inputs.forEach((input, index) => { expect(input.terms).toEqual([`業種${index}`, `industry${index}`]); expect(input.query).toBeUndefined(); expect(input.regions).toEqual(["JP"]); expect(input.roles).toEqual(["代表"]); expect(input.companySizes).toEqual(["10-100"]); });
  expect(result.sample).toBe(false); expect(result.candidates).toHaveLength(6);
});

test("a genuine empty published result remains empty and never calls the draft provider", async () => {
  const result = await executePreviewStage(run(3), { catalog: async () => ({ ...catalog, companies: [], people: [] }) });
  expect(result.sample).toBe(false); expect(result.candidates).toEqual([]);
  const drafted = await executePreviewStage(run(5, result), { ai: async () => { throw new Error("The draft provider must not run for an empty result"); } });
  expect(drafted.drafts).toEqual([]); expect(drafted.sample).toBe(false);
});

test("six campaigns and short search terms are requested without inventing lead counts", async () => {
  const result = await executePreviewStage(run(2), { ai: async input => {
    const schema = input.jsonSchema as { properties: { campaigns: { minItems: number; maxItems: number } } };
    expect(schema.properties.campaigns).toMatchObject({ minItems: 3, maxItems: 6 });
    expect(input.maxOutputTokens).toBeGreaterThanOrEqual(7000);
    return { text: JSON.stringify({ campaigns: campaigns() }), sources: [] };
  } });
  expect(result.campaigns).toHaveLength(6); expect(result.campaigns.every(campaign => campaign.searchTerms.length === 2 && campaign.estimatedLeads === null)).toBe(true);
});

test("fewer than three campaigns and missing search terms fail instead of creating a partial success", async () => {
  await expect(executePreviewStage(run(2), { ai: async () => ({ text: JSON.stringify({ campaigns: campaigns().slice(0, 2) }), sources: [] }) })).rejects.toThrow("3つ以上");
  await expect(executePreviewStage(run(2), { ai: async () => ({ text: JSON.stringify({ campaigns: campaigns().map(campaign => ({ ...campaign, searchTerms: [] })) }), sources: [] }) })).rejects.toThrow("検索する条件");
});

test("fifteen competitors require observed sources and retain the three-search cap", async () => {
  const items = Array.from({ length: 15 }, (_, i) => ({ name: `競合${i}`, website: `https://competitor-${i}.example/`, description: "公開された説明", difference: "事業の違い", sourceUrls: [`https://competitor-${i}.example/`] }));
  const result = await executePreviewStage(run(1), { ai: async input => { expect(input.maxSearchCalls).toBe(3); return { text: JSON.stringify({ competitors: items }), sources: items.map(item => ({ title: item.name, url: item.website })) }; } });
  expect(result.competitors).toHaveLength(15);
  const filtered = await executePreviewStage(run(1), { ai: async () => ({ text: JSON.stringify({ competitors: [items[0], items[0], { ...items[1], website: "https://seller.example/" }, { ...items[2], sourceUrls: ["https://unobserved.example/"] }] }), sources: [{ title: "確認済み", url: items[0].website }, { title: "自社", url: "https://seller.example/" }] }) });
  expect(filtered.competitors).toHaveLength(1);
});

test("draft generation covers all campaigns and rejects omitted or fabricated recipients", async () => {
  const preview = state(); Object.assign(preview, sampleCandidates(preview.campaigns));
  const result = await executePreviewStage(run(5, preview), { ai: async input => {
    const context = JSON.parse(input.user) as { candidates: PreviewState["candidates"] };
    expect(new Set(context.candidates.map(candidate => candidate.campaignId)).size).toBe(6);
    return { text: JSON.stringify({ drafts: context.candidates.map(candidate => ({ candidateId: candidate.id, subject: "ご相談", body: "サンプルの確認用文面です。" })) }), sources: [] };
  } });
  expect(result.drafts).toHaveLength(9); expect(new Set(result.drafts.map(draft => draft.campaignId)).size).toBe(6);
  await expect(executePreviewStage(run(5, preview), { ai: async () => ({ text: JSON.stringify({ drafts: [{ candidateId: "fabricated", subject: "件名", body: "本文" }] }), sources: [] }) })).rejects.toThrow("すべてのキャンペーン");
});
