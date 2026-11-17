import "server-only";
import { createHash } from "node:crypto";
import { ProductError } from "../state";
import type { ResearchDependencies } from "./research";
import type { PreviewState } from "./types";

type FixtureEnvironment = Record<string, string | undefined>;
const TEST_PROJECT_ID = "green-truth-14369079";
// This is the isolated test database, never the production database. Pooler aliases
// normalize to the same fingerprint. A copied project ID alone cannot enable it.
const TEST_DATABASE_HOST = "59acdaf05182aa2eebac8edf05d7fd26688ad10b2724aac5ffd65d9b9fc51d89";
export const PREVIEW_FIXTURE_NOTICE = "会社・競合を含め、すべて検証用の架空データです。実際の調査・送信・課金・営業への取り込みはできません。";

export function isPreviewLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1"].includes(hostname.toLowerCase().replace(/^\[|\]$/g, ""));
}

export function previewFixtureEnabled(env: FixtureEnvironment = process.env): boolean {
  if (env.HIGUCHI_PREVIEW_FIXTURE !== "true" || env.HIGUCHI_MODE !== "live") return false;
  if (env.VERCEL_ENV === "production" || env.VERCEL_TARGET_ENV === "production") return false;
  // A cloud production deployment must not evade the guard by omitting VERCEL_ENV.
  if (env.VERCEL && !["preview", "development"].includes(env.VERCEL_ENV ?? "")) return false;
  let database: URL;
  try { database = new URL(env.DATABASE_URL ?? ""); } catch { return false; }
  if (!["postgres:", "postgresql:"].includes(database.protocol)) return false;
  if (isPreviewLoopback(database.hostname)) return true;
  const fingerprint = createHash("sha256").update(database.hostname.toLowerCase().replace("-pooler.", ".")).digest("hex");
  return env.NEON_PROJECT_ID === TEST_PROJECT_ID && fingerprint === TEST_DATABASE_HOST;
}

/** A requested but unsafe fixture must fail closed, never fall back to real providers. */
export function assertPreviewFixtureConfiguration(env: FixtureEnvironment = process.env): void {
  if (env.HIGUCHI_PREVIEW_FIXTURE === "true" && !previewFixtureEnabled(env)) {
    throw new ProductError("検証用の調査は、本番以外の指定テスト環境でのみ利用できます。", 409, "PREVIEW_FIXTURE_FORBIDDEN");
  }
}

export function previewFixtureLocalHttp(env: FixtureEnvironment = process.env): boolean {
  if (!previewFixtureEnabled(env) || env.VERCEL) return false;
  try {
    const url = new URL(env.BETTER_AUTH_URL ?? env.NEXT_PUBLIC_APP_URL ?? "");
    return url.protocol === "http:" && isPreviewLoopback(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

const company = {
  name: "青葉業務ラボ（架空）", website: "https://aoba-lab.example/",
  business: "架空の法人向け業務改善サービス。定型作業と情報共有を整理し、担当者の業務を支援します。",
  customer: "日本の製造業・卸売業・法人サービス企業", geography: "日本",
  summary: "検証用の架空企業です。営業活動の各画面を確認するための固定データで、実在の会社や事業の分析結果ではありません。",
  sources: [{ title: "検証用の架空データ", url: "https://aoba-lab.example/" }],
};
const segments = [
  ["製造業の業務改善", "製造業", "生産管理責任者", "製造業", "manufacturing"],
  ["卸売業の情報共有", "卸売業", "営業責任者", "卸売業", "wholesale"],
  ["法人サービスの定型作業", "法人サービス企業", "事業責任者", "法人サービス", "business services"],
  ["物流企業の連絡業務", "物流企業", "運営責任者", "物流", "logistics"],
  ["IT企業の営業連携", "IT企業", "営業責任者", "IT", "software"],
  ["建設企業の案件管理", "建設企業", "代表取締役", "建設業", "construction"],
];

/** Overrides every outbound research seam, including caller-supplied overrides. */
export function previewFixtureDependencies(env: FixtureEnvironment = process.env): Partial<ResearchDependencies> {
  assertPreviewFixtureConfiguration(env);
  if (!previewFixtureEnabled(env)) return {};
  return {
    page: async () => ({ url: company.website, text: `${company.name}\n${company.business}\n${company.summary}` }),
    catalog: async () => ({ available: false, datasetRevision: "fixture-v1", companies: [], people: [] }),
    ai: async input => {
      let value: unknown;
      let sources: { title: string; url: string }[] = [];
      if (input.stage === "company") value = company;
      else if (input.stage === "competitors") {
        const competitors = Array.from({ length: 15 }, (_, i) => ({
          name: `架空の業務支援企業 ${i + 1}`, website: `https://competitor-${i + 1}.example/`,
          description: `業務支援サービスの比較表示例 ${i + 1} です。実在する会社ではありません。`,
          difference: ["定型作業の整理を中心に支援", "部門間の情報共有を中心に支援", "案件管理を中心に支援"][i % 3],
          sourceUrls: [`https://competitor-${i + 1}.example/`],
        }));
        sources = competitors.map(c => ({ title: "検証用の架空データ（競合）", url: c.website }));
        value = { competitors };
      } else if (input.stage === "campaigns") value = { campaigns: segments.map(([name, audience, role, ja, en], i) => ({
        name, description: `${audience}に向けた営業企画の表示例です。`, audience,
        valueProposition: "日常の定型作業を整理し、部門間で必要な情報を共有しやすくします。",
        painPoints: "二重入力、担当者ごとの情報管理、手作業での連絡", roles: [role], locations: ["日本"],
        companySizes: [i % 2 ? "100+" : "10-100"], searchTerms: [ja, en],
        includeCriteria: `${audience}で、業務の効率化に取り組む企業`,
        excludeCriteria: "個人、配信停止、対象地域外、競合サービス", emailInstructions: "検証用であることを明記し、短い日本語で情報交換を提案する。",
      })) };
      else if (input.stage === "drafts") {
        const context = JSON.parse(input.user) as { candidates?: { id: string; name: string; company: string; role: string }[] };
        value = { drafts: (context.candidates ?? []).map(candidate => ({
          candidateId: candidate.id, subject: "【検証用・架空】業務改善についての情報交換",
          body: `${candidate.company}\n${candidate.name} 様\n\n青葉業務ラボ（架空）の担当者です。\n${candidate.role}の方に向けた、業務の情報共有を見直す提案の表示例です。\n\n現在、手作業での連絡や二重入力に課題はありますか。\n\nこのメールは検証用の架空の下書きです。実際には送信されません。`,
        })) };
      } else throw new ProductError("検証用の調査工程が見つかりません。", 500, "PREVIEW_FIXTURE_STAGE");
      return { text: JSON.stringify(value), sources };
    },
  };
}

export function markPreviewFixtureState(state: PreviewState, env: FixtureEnvironment = process.env): PreviewState {
  assertPreviewFixtureConfiguration(env);
  if (!previewFixtureEnabled(env)) return state;
  state.sample = true;
  state.notice = PREVIEW_FIXTURE_NOTICE;
  if (state.company) state.company = structuredClone(company);
  for (const candidate of state.candidates) {
    candidate.sample = true; candidate.verification = "sample"; candidate.source = "sample";
    candidate.sourceLabel = "検証用の架空データ";
  }
  for (const prospect of state.companies) prospect.sourceLabel = "検証用の架空データ";
  for (const draft of state.drafts) draft.sample = true;
  return state;
}
