/**
 * Read-only JPY catalog inspection. Secrets come only from individual Vercel env
 * reads into memory. No env files, stdin keys, full Stripe keys or mutations.
 * bun scripts/higuchi-stripe-inspect.ts --production inspect
 * bun scripts/higuchi-stripe-inspect.ts preview inspect
 * Sensitive Vercel values are intentionally not recoverable through this CLI.
 * For production, use the authenticated /api/higuchi/operator/billing-check route.
 */
import { InspectFailure, inspectCheck as check, validateInspectConfig, inspectJpyCatalog, type InspectOptions, type InspectConfig } from "../src/lib/higuchi/billingInspection";
export { createStripeReadOnlyReader, inspectJpyCatalog, validateInspectConfig, type InspectConfig, type InspectOptions } from "../src/lib/higuchi/billingInspection";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = "prj_Jfz4TuWBMR7mPl59pIaISCCve6JV", TEAM = "team_Iic3HLNmnGRA51i7VKtiOMmN";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const INSPECT_ENV_NAMES = ["STRIPE_SECRET_KEY", "STRIPE_ACCOUNT_ID", "STRIPE_JPY_PRODUCT_ID", "STRIPE_JPY_METER_ID", "STRIPE_JPY_PRICE_ID", "STRIPE_JPY_METER_EVENT_NAME", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "STRIPE_PUBLISHABLE_KEY", "HIGUCHI_BILLING_CURRENCY"] as const;
type Json = Record<string, unknown>;
type CliJson = (path: string) => Json;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

export function parseInspectArguments(args: string[]): InspectOptions {
  if (args.length === 1 && args[0] === "--help") return { target: "preview", help: true };
  check(args.length === 2 && args[1] === "inspect" && ["--production", "preview"].includes(args[0]), "EXPLICIT_READ_ONLY_TARGET_REQUIRED");
  return { target: args[0] === "--production" ? "production" : "preview", help: false };
}

/** Env list responses are metadata only; each exact value is fetched separately. */
export function loadInspectEnvironment(options: InspectOptions, cli: CliJson, names: readonly string[] = INSPECT_ENV_NAMES): Record<string, string> {
  const project = cli(`/v9/projects/${PROJECT}?teamId=${TEAM}`);
  check(project.id === PROJECT && project.name === "form-higuchi" && project.accountId === TEAM, "PROJECT_IDENTITY_MISMATCH");
  const list = cli(`/v10/projects/${PROJECT}/env?teamId=${TEAM}`);
  check(Array.isArray(list.envs), "ENV_LIST_INVALID");
  const entries = list.envs.map(object), env: Record<string, string> = {};
  for (const name of names) {
    const candidates = entries.filter(entry => entry.key === name && Array.isArray(entry.target) && entry.target.includes(options.target) && !entry.gitBranch);
    if (["NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "STRIPE_PUBLISHABLE_KEY"].includes(name) && !candidates.length) continue;
    check(candidates.length === 1 && typeof candidates[0].id === "string", "ENV_NOT_UNIQUE");
    if (name === "STRIPE_SECRET_KEY") check(["sensitive", "encrypted"].includes(String(candidates[0].type)), "RESTRICTED_KEY_MUST_BE_SECRET");
    const entry = cli(`/v1/projects/${PROJECT}/env/${encodeURIComponent(String(candidates[0].id))}?teamId=${TEAM}`);
    const plainNonSecret = name !== "STRIPE_SECRET_KEY" && candidates[0].type === "plain" && entry.type === "plain";
    const safeType = (value: unknown) => ["plain", "encrypted", "sensitive", "system", "secret"].includes(String(value)) ? String(value) : value === undefined ? "missing" : "other";
    check(entry.key === name && typeof entry.value === "string" && (entry.decrypted === true || plainNonSecret), "INDIVIDUAL_ENV_READ_INVALID", {
      stage: "individual_env_read", envKey: name, listedType: safeType(candidates[0].type), returnedType: safeType(entry.type), returnedKeyMatches: entry.key === name,
      valueType: typeof entry.value, decrypted: typeof entry.decrypted === "boolean" ? entry.decrypted : "missing", responseFields: ["env", "key", "value", "type", "decrypted", "id", "error"].filter(field => Object.hasOwn(entry, field)),
    });
    env[name] = entry.value;
  }
  return env;
}
export function loadInspectConfig(options: InspectOptions, cli: CliJson): InspectConfig {
  return validateInspectConfig(loadInspectEnvironment(options, cli), options);
}

export function readVercelInspectorJson(path: string): Json {
  check(process.env.APPDATA, "AUTHENTICATED_VERCEL_CLI_REQUIRED");
  const cli = join(process.env.APPDATA, "npm", "node_modules", "vercel", "dist", "vc.js");
  check(existsSync(cli), "AUTHENTICATED_VERCEL_CLI_REQUIRED");
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) if (key.startsWith("STRIPE_") || key === "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY") delete childEnv[key];
  const result = spawnSync("node", [cli, "api", path, "--raw", "--non-interactive"], { cwd: ROOT, env: childEnv, encoding: "utf8", windowsHide: true, timeout: 60000, maxBuffer: 5000000 });
  check(!result.error && result.status === 0, "VERCEL_READ_FAILED");
  let value: unknown; try { value = JSON.parse(result.stdout); } catch { throw new InspectFailure("VERCEL_RESPONSE_INVALID"); }
  const response = object(value); check(!response.error, "VERCEL_READ_REJECTED"); return response;
}

async function main() {
  const options = parseInspectArguments(process.argv.slice(2));
  if (options.help) { console.log("higuchi-stripe-inspect --production inspect | preview inspect\nRead-only JPY catalog check. Uses authenticated Vercel CLI; accepts no keys or env files."); return; }
  const config = loadInspectConfig(options, readVercelInspectorJson);
  console.log(JSON.stringify(await inspectJpyCatalog(config)));
}
if (import.meta.main) {
  try { await main(); } catch (error) {
    console.error(JSON.stringify({ status: "failed", mutation: false, code: error instanceof InspectFailure ? error.code : "INSPECTION_FAILED_DETAILS_REDACTED", ...(error instanceof InspectFailure ? error.diagnostics : {}), ...(error instanceof InspectFailure && error.httpStatus ? { httpStatus: error.httpStatus } : {}), detailsRedacted: true }));
    process.exitCode = 1;
  }
}
