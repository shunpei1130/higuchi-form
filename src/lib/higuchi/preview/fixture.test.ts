import { expect, test } from "bun:test";
import { assertPreviewFixtureConfiguration, markPreviewFixtureState, previewFixtureEnabled, previewFixtureLocalHttp, PREVIEW_FIXTURE_NOTICE } from "./fixture";
import { executePreviewStage, type ResearchDependencies } from "./research";
import { previewDispatchUrl } from "./dispatch";
import { previewCookie, previewSnapshot, type PreviewRun } from "./store";
import { emptyPreviewState, PREVIEW_STAGES } from "./types";

const local = {
  HIGUCHI_PREVIEW_FIXTURE: "true", HIGUCHI_MODE: "live", NODE_ENV: "production",
  DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:5432/higuchi_fixture",
  BETTER_AUTH_URL: "http://127.0.0.1:4321", VERCEL: undefined, VERCEL_ENV: undefined, VERCEL_TARGET_ENV: undefined,
};
async function withEnvironment(values: Record<string, string | undefined>, action: () => void | Promise<void>) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { await action(); } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
function run(): PreviewRun {
  const now = new Date();
  return {
    id: "00000000-0000-4000-8000-000000000001", sessionId: "00000000-0000-4000-8000-000000000002",
    input: { website: "https://real-input.invalid/", business: "入力された実事業", customer: "実在する顧客", geography: "実地域" },
    state: emptyPreviewState(), status: "running", revision: 0, generation: 0, stageIndex: 0, attempts: 1, retryCount: 0,
    lockedBy: "fixture-test", leaseUntil: now, runAfter: now, errorCode: null, errorMessage: null, errorRetryable: 0,
    claimedOrganizationId: null, claimedProjectId: null, claimedAt: null, expiresAt: now, createdAt: now, updatedAt: now,
  };
}

test("fixture requires explicit live mode and an isolated database even in a production build", () => {
  expect(previewFixtureEnabled(local)).toBe(true);
  expect(previewFixtureEnabled({ ...local, DATABASE_URL: "postgres://fixture:fixture@[::1]/test" })).toBe(true);
  for (const change of [
    { HIGUCHI_PREVIEW_FIXTURE: undefined }, { HIGUCHI_PREVIEW_FIXTURE: "false" },
    { HIGUCHI_MODE: "simulation" }, { HIGUCHI_MODE: undefined }, { DATABASE_URL: undefined },
    { DATABASE_URL: "https://localhost/test" }, { DATABASE_URL: "postgres://fixture@unknown-db.example/test" },
    { NEON_PROJECT_ID: "green-truth-14369079", DATABASE_URL: "postgres://fixture@unknown-db.example/test" },
  ]) expect(previewFixtureEnabled({ ...local, ...change })).toBe(false);
});

test("production cloud flags always reject fixtures regardless of the requested flag or database", () => {
  for (const change of [
    { VERCEL_ENV: "production" }, { VERCEL_TARGET_ENV: "production" },
    { VERCEL: "1", VERCEL_ENV: undefined }, { VERCEL: "1", VERCEL_ENV: "unknown" },
  ]) {
    const env = { ...local, ...change };
    expect(previewFixtureEnabled(env)).toBe(false);
    expect(() => assertPreviewFixtureConfiguration(env)).toThrow("本番以外");
  }
  expect(previewFixtureEnabled({ ...local, VERCEL: "1", VERCEL_ENV: "preview" })).toBe(true);
  expect(() => assertPreviewFixtureConfiguration({ ...local, HIGUCHI_PREVIEW_FIXTURE: undefined, VERCEL_ENV: "production" })).not.toThrow();
});

test("local HTTP dispatch and cookie exception exist only for the guarded local fixture", async () => {
  expect(previewFixtureLocalHttp(local)).toBe(true);
  expect(previewDispatchUrl(local)).toBe("http://127.0.0.1:4321/api/previews/dispatch");
  for (const change of [
    { HIGUCHI_PREVIEW_FIXTURE: undefined }, { VERCEL_ENV: "production" },
    { BETTER_AUTH_URL: "http://192.168.1.10:4321" }, { BETTER_AUTH_URL: "http://unknown.example" },
    { BETTER_AUTH_URL: "http://user:secret@127.0.0.1:4321" }, { VERCEL: "1", VERCEL_ENV: "preview" },
  ]) expect(() => previewDispatchUrl({ ...local, ...change })).toThrow();
  await withEnvironment(local, () => expect(previewCookie("a".repeat(43))).not.toContain("; Secure"));
  await withEnvironment({ ...local, VERCEL_ENV: "production" }, () => expect(previewCookie("a".repeat(43))).toContain("; Secure"));
});

test("unsafe fixture requests fail before any injected or real provider can run", async () => {
  await withEnvironment({ ...local, VERCEL_ENV: "production" }, async () => {
    let calls = 0;
    const unexpected = async () => { calls++; throw new Error("External provider must not run"); };
    await expect(executePreviewStage(run(), { page: unexpected, ai: unexpected, catalog: unexpected })).rejects.toMatchObject({ code: "PREVIEW_FIXTURE_FORBIDDEN" });
    expect(calls).toBe(0);
  });
});

test("all six stages are fictional and make zero external calls, overriding every provider seam", async () => {
  await withEnvironment(local, async () => {
    let calls = 0;
    const unexpected = async () => { calls++; throw new Error("External provider must not run"); };
    const overrides: ResearchDependencies = { page: unexpected, ai: unexpected, catalog: unexpected };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = unexpected as unknown as typeof fetch;
    try {
      const current = run(); current.state = markPreviewFixtureState(current.state);
      expect(current.state.notice).toBe(PREVIEW_FIXTURE_NOTICE);
      for (let stageIndex = 0; stageIndex < PREVIEW_STAGES.length; stageIndex++) {
        current.stageIndex = stageIndex; current.state = await executePreviewStage(current, overrides);
        expect(current.state.sample).toBe(true); expect(current.state.notice).toBe(PREVIEW_FIXTURE_NOTICE);
      }
      expect(current.state.company?.name).toContain("架空");
      expect(new URL(current.state.company!.website).hostname.endsWith(".example")).toBe(true);
      expect(current.state.company?.business).not.toContain("入力された実事業");
      expect(current.state.competitors.length).toBeGreaterThanOrEqual(3);
      expect(current.state.competitors.every(c => new URL(c.website).hostname.endsWith(".example"))).toBe(true);
      expect(current.state.campaigns.length).toBeGreaterThanOrEqual(3);
      expect(current.state.candidates.length).toBeGreaterThan(0);
      expect(current.state.candidates.every(c => c.sample && c.source === "sample" && c.verification === "sample" && c.email.endsWith(".example"))).toBe(true);
      expect(current.state.drafts.length).toBeGreaterThan(0);
      expect(current.state.drafts.every(d => d.sample && d.body.includes("検証用"))).toBe(true);
      current.status = "ready";
      expect(previewSnapshot(current).capabilities).toMatchObject({ canCheckout: false, canClaim: false, canActivate: false });
      expect(calls).toBe(0);
    } finally { globalThis.fetch = originalFetch; }
  });
});
