/**
 * Node --experimental-strip-types scripts/higuchi-with-vercel-db.ts [preview] inspect|setup|upgrade|booking-test|jobs-test
 * Node --experimental-strip-types scripts/higuchi-with-vercel-db.ts --production inspect|setup|upgrade|bootstrap|ai-test
 * Vercel's authenticated CLI captures credentials in memory; neither credentials
 * nor raw subprocess output are printed or written. Production is explicit and
 * permits fixed provisioning scripts and one guarded AI smoke; it never runs booking tests.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = "prj_Jfz4TuWBMR7mPl59pIaISCCve6JV";
const TEAM = "team_Iic3HLNmnGRA51i7VKtiOMmN";
const TEST_RESOURCE = "store_F0QpZSOlYrYoBWSC";
const PROD_RESOURCE = "store_ClW2DbnHVveUdiht";
const PROD_PROJECT = "fancy-bird-03831252";
const PROD_HOST_HASH = "eacaef515b7de2f15d6dbad667235fe8786402a07bf27d3a6c01a8157091c269";
// The dedicated Preview resource is separate from the production Neon project.
const TEST_PROJECT = "green-truth-14369079";
const TEST_HOST_HASH = "59acdaf05182aa2eebac8edf05d7fd26688ad10b2724aac5ffd65d9b9fc51d89";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const input = process.argv.slice(2);
const production = input[0] === "--production";
const target = production ? "production" : "preview";
const explicitMode = production || input[0] === "preview";
const operation = input[explicitMode ? 1 : 0] ?? "inspect";
const commands: Record<string, string[]> = production ? {
  setup: ["scripts/db/setup.ts", "--if-empty"],
  upgrade: ["scripts/db/higuchi-setup.ts"],
  bootstrap: ["scripts/db/higuchi-bootstrap-operator.ts", "--apply", "--confirm-operator=s.hasegawa1130@gmail.com"],
  "ai-test": ["--conditions=react-server", "scripts/higuchi-ai-smoke.ts"],
} : {
  setup: ["scripts/db/setup.ts"],
  upgrade: ["scripts/db/higuchi-setup.ts"],
  "booking-test": ["test", "--conditions=react-server", "src/lib/higuchi/booking/service.integration.test.ts"],
  "jobs-test": ["test", "--conditions=react-server", "src/lib/higuchi/jobs/store.integration.test.ts"],
};
const allowedOperations = new Set(["inspect", ...Object.keys(commands)]);
type EnvEntry = { key?: string; value?: string; target?: string[]; id?: string; gitBranch?: string | null; integrationConfigurationId?: string };

function fail(message: string): never { console.error(message); process.exit(1); }
function cliJson(args: string[]): unknown {
  const appData = process.env.APPDATA;
  if (!appData) return fail("Vercel CLI の保存先が見つかりません。");
  const cli = join(appData, "npm", "node_modules", "vercel", "dist", "vc.js");
  if (!existsSync(cli)) return fail("認証済みのVercel CLIが見つかりません。");
  const response = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 5_000_000 });
  if (response.error || response.status !== 0) return fail("Vercelの接続情報を取得できませんでした。生の出力は表示していません。");
  try { return JSON.parse(response.stdout); } catch { return fail("Vercelの応答形式を確認できませんでした。"); }
}
function envValue(entries: EnvEntry[], key: string): string {
  const candidates = entries.filter(entry => entry.key === key && entry.target?.includes(target) && !entry.gitBranch);
  if (candidates.length !== 1 || typeof candidates[0].id !== "string") return fail(`選択環境の ${key} を一意に取得できませんでした。`);
  const value = cliJson(["api", `/v1/projects/${PROJECT}/env/${encodeURIComponent(candidates[0].id)}?teamId=${TEAM}`, "--raw"]);
  if (!value || typeof value !== "object" || !("key" in value) || value.key !== key || !("value" in value) || typeof value.value !== "string" || !("decrypted" in value) || value.decrypted !== true) return fail(`選択した ${key} を安全に取得できませんでした。`);
  return value.value;
}
function main() {
  if (input.length > (explicitMode ? 2 : 1) || !allowedOperations.has(operation)) return fail("許可された固定操作だけを指定してください。本番は --production の明示が必要です。");
  const response = cliJson(["api", `/v10/projects/${PROJECT}/env?teamId=${TEAM}`, "--raw"]);
  if (!response || typeof response !== "object" || !("envs" in response) || !Array.isArray(response.envs)) return fail("Vercelの環境設定を確認できませんでした。");
  const entries = response.envs as EnvEntry[];
  const neonProject = envValue(entries, "NEON_PROJECT_ID");
  const expectedProject = production ? PROD_PROJECT : TEST_PROJECT;
  if (neonProject !== expectedProject) return fail("指定環境のデータベース識別情報が一致しません。");
  const connection = envValue(entries, "DATABASE_URL_UNPOOLED");
  const pooledConnection = envValue(entries, "DATABASE_URL");
  let url: URL; try { url = new URL(connection); } catch { return fail("データベースの接続形式が不正です。"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname.endsWith(".neon.tech") || url.hostname.includes("-pooler.") || !url.username || !url.password || url.searchParams.get("sslmode") !== "require") return fail("直接接続・TLS必須のNeon接続ではありません。");
  const pooledUrl = new URL(pooledConnection);
  if (pooledUrl.hostname.replace("-pooler.", ".") !== url.hostname || pooledUrl.pathname !== url.pathname || pooledUrl.username !== url.username) return fail("通常接続と直接接続のDBが一致しません。");
  const hostHash = createHash("sha256").update(url.hostname).digest("hex");
  if (operation === "inspect") { console.log(JSON.stringify({ target, resource: production ? PROD_RESOURCE : TEST_RESOURCE, neonProjectId: neonProject, directHostFingerprint: hostHash, mutation: false })); return; }
  if (hostHash !== (production ? PROD_HOST_HASH : TEST_HOST_HASH)) return fail("データベースの固定接続先が一致しません。");
  const bun = join(root, ".cache", "npm", "_npx", "60c3515df86f25b1", "node_modules", "bun", "bin", "bun.exe");
  if (!existsSync(bun)) return fail("既存のBun実行環境が見つかりません。");
  const args = commands[operation];
  if (!args) return fail("固定された実行コマンドを確認できませんでした。");
  const child = spawnSync(bun, args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 240_000, maxBuffer: 5_000_000, env: { ...process.env, DATABASE_URL: connection, DATABASE_URL_UNPOOLED: connection, DATABASE_SSL: "require", DB_POOL_MAX: "2", NEON_PROJECT_ID: neonProject, VERCEL_ENV: target, HIGUCHI_MODE: "live", HIGUCHI_AI_SMOKE_ALLOW: production && operation === "ai-test" ? "production-one-call" : "", HIGUCHI_BOOKING_TEST_DATABASE_URL: operation === "booking-test" ? connection : "", HIGUCHI_JOBS_TEST_DATABASE_URL: operation === "jobs-test" ? connection : "", RESEND_API_KEY: "", OPENAI_API_KEY: "", GOOGLE_CLIENT_SECRET: "" } });
  const passed = !child.error && child.status === 0;
  const summary = `${child.stdout ?? ""}\n${child.stderr ?? ""}`.split(/\r?\n/).map(line => line.trim()).filter(line => /^\d+ (?:pass|fail|skip)$/.test(line) || /^Ran \d+ tests across \d+ files?\./.test(line));
  let aiResult: unknown;
  if (operation === "ai-test") { try { const value = JSON.parse(child.stdout.trim()); if (value && typeof value === "object" && typeof value.success === "boolean") aiResult = value.success === true && value.model === "gpt-6-luna" && Number.isFinite(value.usageUSD) && Number.isFinite(value.totalUsageUSD) ? { success: true, model: value.model, usageUSD: value.usageUSD, totalUsageUSD: value.totalUsageUSD } : { success: false, code: typeof value.code === "string" && /^AI_SMOKE_[A-Z_]+$/.test(value.code) ? value.code : "AI_SMOKE_FAILED" }; } catch { aiResult = { success: false, code: "AI_SMOKE_FAILED" }; } }
  console.log(JSON.stringify({ target, operation, passed, exitCode: child.status, summary, ...(aiResult ? { aiResult } : {}), detailsRedacted: true }));
  if (!passed) process.exit(1);
}
try { main(); } catch { fail("検証用データベースの処理を完了できませんでした。接続情報を含む出力は表示していません。"); }
