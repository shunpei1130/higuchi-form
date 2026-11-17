/** Configure this project's isolated Preview without reading or copying secret values. */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "prj_Jfz4TuWBMR7mPl59pIaISCCve6JV", TEAM = "team_Iic3HLNmnGRA51i7VKtiOMmN";
const CORE_SECRETS = ["BETTER_AUTH_SECRET", "INTEGRATION_CREDENTIALS_KEY", "UNSUBSCRIBE_SECRET", "BOOKING_TOKEN_SECRET", "CRON_SECRET"];
const PLAIN_SETTINGS: Record<string, string> = { HIGUCHI_MODE: "live", AUTH_SIGNUP: "invite-only", HIGUCHI_SEND_ENABLED: "false", DB_POOL_MAX: "2", HIGUCHI_AI_MONTHLY_USD: "0", HIGUCHI_OPENAI_MODEL: "gpt-6-luna" };
const FORBIDDEN_PREVIEW = ["OPENAI_API_KEY", "GOOGLE_MAIL_CLIENT_ID", "GOOGLE_MAIL_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "BETTER_AUTH_URL", "NEXT_PUBLIC_APP_URL"];
type Entry = { key?: string; type?: string; target?: string[]; gitBranch?: string | null };
function fail(code: string): never { throw new Error(code); }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function cli(args: string[], input?: string): string {
  const appData = process.env.APPDATA; if (!appData) fail("CLI_UNAVAILABLE");
  const entry = join(appData, "npm", "node_modules", "vercel", "dist", "vc.js"); if (!existsSync(entry)) fail("CLI_UNAVAILABLE");
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: ROOT, input, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 5_000_000 });
  if (result.error || result.status !== 0) fail("CLI_OPERATION_FAILED");
  return result.stdout;
}
function api(path: string): Record<string, unknown> { try { return object(JSON.parse(cli(["api", path, "--raw", "--non-interactive"]))); } catch (error) { if (error instanceof Error && error.message === "CLI_OPERATION_FAILED") throw error; return fail("API_RESPONSE_INVALID"); } }
function entries(): Entry[] { const response = api(`/v10/projects/${PROJECT}/env?teamId=${TEAM}`); if (!Array.isArray(response.envs)) fail("ENV_METADATA_INVALID"); return response.envs.map(item => object(item) as Entry); }
function verifyProject() {
  const context = object(JSON.parse(readFileSync(join(ROOT, ".vercel", "project.json"), "utf8")));
  if (context.projectId !== PROJECT || context.orgId !== TEAM) fail("PROJECT_LINK_MISMATCH");
  const project = api(`/v9/projects/${PROJECT}?teamId=${TEAM}`);
  if (project.id !== PROJECT || project.accountId !== TEAM || project.name !== "form-higuchi") fail("PROJECT_IDENTITY_MISMATCH");
}
function inspect(all: Entry[]) {
  const preview = all.filter(entry => entry.target?.includes("preview"));
  const forbidden = preview.filter(entry => entry.key && FORBIDDEN_PREVIEW.includes(entry.key));
  if (forbidden.length) { console.log(JSON.stringify({ status: "blocked", code: "UNEXPECTED_PREVIEW_PROVIDER_OR_ORIGIN", names: [...new Set(forbidden.map(entry => entry.key))] })); fail("UNEXPECTED_PREVIEW_PROVIDER_OR_ORIGIN"); }
  const owned = new Set([...CORE_SECRETS, ...Object.keys(PLAIN_SETTINGS)]);
  if (preview.some(entry => entry.key && owned.has(entry.key) && (entry.gitBranch || entry.target?.some(target => target !== "preview")))) fail("SHARED_OR_BRANCH_CONFIGURATION_REQUIRES_REVIEW");
  for (const name of owned) if (preview.filter(entry => entry.key === name).length > 1) fail("AMBIGUOUS_PREVIEW_CONFIGURATION");
  return { missing: CORE_SECRETS.filter(name => !preview.some(entry => entry.key === name)), preserved: CORE_SECRETS.filter(name => preview.some(entry => entry.key === name)) };
}
async function main() {
  const mode = process.argv[2] ?? "plan"; if (process.argv.length > 3 || !["plan", "apply"].includes(mode)) fail("INVALID_OPERATION");
  verifyProject(); const initial = entries(), plan = inspect(initial);
  if (mode === "plan") { console.log(JSON.stringify({ status: "plan", target: "preview", missingCoreNames: plan.missing, preservedCoreNames: plan.preserved, plainNames: Object.keys(PLAIN_SETTINGS), providerAndProductionOriginsAbsent: true, deploymentStarted: false })); return; }
  for (const name of plan.missing) {
    // Each missing secret gets independent entropy; Production values are never fetched.
    const value = randomBytes(48).toString("base64url");
    cli(["env", "add", name, "preview", "--sensitive", "--yes", "--scope", TEAM, "--non-interactive"], value);
  }
  for (const [name, value] of Object.entries(PLAIN_SETTINGS)) cli(["env", "add", name, "preview", "--no-sensitive", "--force", "--yes", "--scope", TEAM, "--non-interactive"], value);
  const final = entries(); const checked = inspect(final); if (checked.missing.length) fail("PREVIEW_SETUP_INCOMPLETE");
  const protectedNames = ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "NEON_PROJECT_ID", "STRIPE_SECRET_KEY", "STRIPE_ACCOUNT_ID"];
  const protectedMetadata = (records: Entry[]) => JSON.stringify(records.filter(entry => protectedNames.includes(entry.key ?? "")).map(entry => ({ key: entry.key, type: entry.type, target: entry.target, gitBranch: entry.gitBranch })).sort((a, b) => (a.key ?? "").localeCompare(b.key ?? "")));
  if (protectedMetadata(initial) !== protectedMetadata(final)) fail("DATABASE_OR_STRIPE_METADATA_CHANGED");
  console.log(JSON.stringify({ status: "configured", target: "preview", createdCoreNames: plan.missing, preservedCoreNames: plan.preserved, configuredPlainNames: Object.keys(PLAIN_SETTINGS), dbAndStripeUntouched: true, productionUntouched: true, providerAndProductionOriginsAbsent: true, deploymentStarted: false }));
}
try { await main(); } catch (error) { console.log(JSON.stringify({ status: "failed", code: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "PREVIEW_SETUP_FAILED", detailsRedacted: true })); process.exitCode = 1; }
