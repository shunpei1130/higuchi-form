/** Encrypted, one-time bridge from the credential UI to fixed operator commands. */
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIRECTORY = join(ROOT, ".higuchi");
const PUBLIC_FILE = join(DIRECTORY, "provider-transfer.public.pem");
const PRIVATE_FILE = join(DIRECTORY, "provider-transfer.private.pem");
const ENCRYPTED_FILE = join(DIRECTORY, "provider-transfer.enc.json");
const PROJECT = "prj_Jfz4TuWBMR7mPl59pIaISCCve6JV", TEAM = "team_Iic3HLNmnGRA51i7VKtiOMmN";
const TEST_ACCOUNT = "acct_1UcblRRGx64luiLk", LIVE_ACCOUNT = "acct_1SOtr4EXrauv37Rg";
const OPERATION = process.argv[2] ?? "";
const OPERATIONS = new Set(["prepare", "google", "stripe-test-catalog", "stripe-test", "stripe-live-catalog", "stripe-test-runtime", "stripe-live-runtime", "cleanup"]);
type Payload = { googleClientId?: string; googleClientSecret?: string; stripeTestKey?: string; stripeTestRestricted?: string; stripeLiveRestricted?: string };
class TransferError extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; } }
function fail(code: string): never { throw new TransferError(code); }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function directory() {
  if (!existsSync(DIRECTORY)) mkdirSync(DIRECTORY, { mode: 0o700 });
  if (lstatSync(DIRECTORY).isSymbolicLink() || !lstatSync(DIRECTORY).isDirectory()) fail("TRANSFER_DIRECTORY_INVALID");
}
function regularFile(path: string) {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) fail("TRANSFER_FILE_INVALID");
}
function prepare() {
  directory();
  if ([PUBLIC_FILE, PRIVATE_FILE, ENCRYPTED_FILE].some(path => existsSync(path))) fail("TRANSFER_ALREADY_EXISTS");
  const keys = generateKeyPairSync("rsa", { modulusLength: 4096, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  writeFileSync(PRIVATE_FILE, keys.privateKey, { encoding: "utf8", mode: 0o600, flag: "wx" });
  writeFileSync(PUBLIC_FILE, keys.publicKey, { encoding: "utf8", mode: 0o644, flag: "wx" });
  console.log(JSON.stringify({ operation: OPERATION, status: "prepared" }));
}
function bytes(value: unknown, expected?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 400_000) fail("TRANSFER_ENVELOPE_INVALID");
  const result = Buffer.from(value, "base64");
  if (!result.length || expected !== undefined && result.length !== expected) fail("TRANSFER_ENVELOPE_INVALID");
  return result;
}
function decrypt(): Payload {
  directory(); regularFile(PRIVATE_FILE); regularFile(ENCRYPTED_FILE);
  if (lstatSync(ENCRYPTED_FILE).size > 400_000) fail("TRANSFER_TOO_LARGE");
  let envelope: Record<string, unknown>; try { envelope = object(JSON.parse(readFileSync(ENCRYPTED_FILE, "utf8"))); } catch { return fail("TRANSFER_ENVELOPE_INVALID"); }
  if (envelope.v !== 1 || Object.keys(envelope).some(key => !["v", "wrappedKey", "iv", "tag", "ciphertext"].includes(key))) fail("TRANSFER_ENVELOPE_INVALID");
  let key: Buffer | undefined, plain: Buffer | undefined;
  try {
    key = privateDecrypt({ key: readFileSync(PRIVATE_FILE, "utf8"), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, bytes(envelope.wrappedKey, 512));
    if (key.length !== 32) fail("TRANSFER_KEY_INVALID");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes(envelope.iv, 12)); decipher.setAuthTag(bytes(envelope.tag, 16));
    plain = Buffer.concat([decipher.update(bytes(envelope.ciphertext)), decipher.final()]);
    const payload = object(JSON.parse(plain.toString("utf8")));
    const fields = ["googleClientId", "googleClientSecret", "stripeTestKey", "stripeTestRestricted", "stripeLiveRestricted"];
    if (!Object.keys(payload).length || Object.entries(payload).some(([name, value]) => !fields.includes(name) || typeof value !== "string" || !value || value.length > 16_384 || /[\r\n\0]/.test(value))) fail("TRANSFER_PAYLOAD_INVALID");
    return payload as Payload;
  } catch (error) { if (error instanceof TransferError) throw error; return fail("TRANSFER_DECRYPT_FAILED"); }
  finally { key?.fill(0); plain?.fill(0); }
}
function cliPath(): string {
  if (!process.env.APPDATA) fail("VERCEL_CLI_UNAVAILABLE");
  const path = join(process.env.APPDATA, "npm", "node_modules", "vercel", "dist", "vc.js");
  if (!existsSync(path)) fail("VERCEL_CLI_UNAVAILABLE"); return path;
}
function cli(args: string[], input?: string): string {
  const result = spawnSync(process.execPath, [cliPath(), ...args], { cwd: ROOT, input, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 5_000_000 });
  if (result.error || result.status !== 0) fail("VERCEL_OPERATION_FAILED");
  return result.stdout;
}
function verifyProject() {
  let context: Record<string, unknown>; try { context = object(JSON.parse(readFileSync(join(ROOT, ".vercel", "project.json"), "utf8"))); } catch { return fail("VERCEL_PROJECT_LINK_REQUIRED"); }
  if (context.projectId !== PROJECT || context.orgId !== TEAM) fail("VERCEL_PROJECT_LINK_MISMATCH");
  let project: Record<string, unknown>; try { project = object(JSON.parse(cli(["api", `/v9/projects/${PROJECT}?teamId=${TEAM}`, "--raw", "--non-interactive"]))); } catch (error) { if (error instanceof TransferError) throw error; return fail("VERCEL_PROJECT_RESPONSE_INVALID"); }
  if (project.id !== PROJECT || project.accountId !== TEAM || project.name !== "form-higuchi") fail("VERCEL_PROJECT_IDENTITY_MISMATCH");
}
function register(name: string, value: string, target: "production" | "preview", sensitive = true) {
  cli(["env", "add", name, target, sensitive ? "--sensitive" : "--no-sensitive", "--force", "--yes", "--scope", TEAM, "--non-interactive"], value);
}
async function verifyStripeKey(key: string, accountId: string, live: boolean) {
  if (!new RegExp(`^rk_${live ? "live" : "test"}_[A-Za-z0-9_-]{10,500}$`).test(key)) fail("STRIPE_RESTRICTED_KEY_REQUIRED");
  const response = await fetch("https://api.stripe.com/v1/account", { headers: { Authorization: `Bearer ${key}`, "Stripe-Version": "2026-10-28.endive" }, cache: "no-store", signal: AbortSignal.timeout(25_000) });
  if (!response.ok) fail(response.status === 403 ? "STRIPE_ACCOUNT_VERIFY_PERMISSION_REQUIRED" : "STRIPE_ACCOUNT_VERIFY_FAILED");
  const account = object(await response.json()); if (account.id !== accountId) fail("STRIPE_ACCOUNT_IDENTITY_MISMATCH");
}
const SAFE_FIELDS = new Set(["status", "accountId", "livemode", "target", "productId", "meterId", "priceId", "eventName", "webhook", "environmentRegistration", "mode", "runId", "organizationId", "customerId", "paymentMethodId", "setupIntentId", "subscriptionId", "creditGrantId", "meterEventIdentifier", "setupStatus", "trialGrantStatus", "subscriptionStatus", "meterStatus", "promotionPolicyStatus", "prepaidCheckoutStatus", "applicationWebhookStatus", "fixtureStatus", "phase", "stage", "code", "failureStatus", "stripeStatus", "stripeCode", "parameter"]);
function safeResult(text: string): Record<string, unknown> {
  let value: Record<string, unknown>; try { value = object(JSON.parse(text.trim().split(/\r?\n/).at(-1) ?? "")); } catch { return {}; }
  return Object.fromEntries(Object.entries(value).filter(([name, item]) => SAFE_FIELDS.has(name) && (typeof item === "boolean" || typeof item === "number" && Number.isFinite(item) || typeof item === "string" && /^[A-Za-z0-9_.:/@\[\] -]{1,250}$/.test(item) && !/(?:rk|sk)_(?:live|test)_|whsec_|GOCSPX|postgres(?:ql)?:\/\//.test(item))));
}
function stripeChild(key: string, catalogOnly: boolean, live = false) {
  if (live ? !catalogOnly || !/^rk_live_[A-Za-z0-9_-]{10,500}$/.test(key) : !/^(?:rk|sk)_test_[A-Za-z0-9_-]{10,500}$/.test(key)) fail(live ? "STRIPE_LIVE_CATALOG_RESTRICTED_KEY_REQUIRED" : "STRIPE_TEST_KEY_REQUIRED");
  const bun = join(ROOT, ".cache", "npm", "_npx", "60c3515df86f25b1", "node_modules", "bun", "bin", "bun.exe"); if (!existsSync(bun)) fail("BUN_UNAVAILABLE");
  const args = ["--conditions=react-server", catalogOnly ? "scripts/higuchi-stripe-provision.ts" : "scripts/higuchi-stripe-test.ts", "--key-stdin", "--account-id", live ? LIVE_ACCOUNT : TEST_ACCOUNT, ...(catalogOnly ? ["--catalog-only"] : []), ...(live ? ["--allow-live"] : [])];
  const child = spawnSync(bun, args, { cwd: ROOT, input: key, encoding: "utf8", windowsHide: true, timeout: 240_000, maxBuffer: 5_000_000, env: { ...process.env, STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "", OPENAI_API_KEY: "", RESEND_API_KEY: "" } });
  const passed = !child.error && child.status === 0;
  console.log(JSON.stringify({ operation: OPERATION, status: passed ? "success" : "failed", result: safeResult(passed ? child.stdout : child.stderr), detailsRedacted: true }));
  if (!passed) process.exitCode = 1;
}
async function main() {
  if (process.argv.length !== 3 || !OPERATIONS.has(OPERATION)) fail("TRANSFER_OPERATION_INVALID");
  if (OPERATION === "prepare") { prepare(); return; }
  if (OPERATION === "cleanup") {
    directory();
    for (const path of [PUBLIC_FILE, PRIVATE_FILE, ENCRYPTED_FILE]) if (existsSync(path)) regularFile(path);
    for (const path of [PUBLIC_FILE, PRIVATE_FILE, ENCRYPTED_FILE]) if (existsSync(path)) unlinkSync(path);
    console.log(JSON.stringify({ operation: OPERATION, status: "cleaned", removedOnlyTransferFiles: true })); return;
  }
  const payload = decrypt();
  if (OPERATION === "stripe-test-catalog" || OPERATION === "stripe-test") { stripeChild(payload.stripeTestKey ?? "", OPERATION === "stripe-test-catalog"); return; }
  // One fixed live catalog command only; it never registers the temporary catalog-write key.
  if (OPERATION === "stripe-live-catalog") { stripeChild(payload.stripeLiveRestricted ?? "", true, true); return; }
  verifyProject();
  if (OPERATION === "google") {
    const id = payload.googleClientId ?? "", secret = payload.googleClientSecret ?? "";
    if (!/^[A-Za-z0-9_-]{10,250}\.apps\.googleusercontent\.com$/.test(id) || !/^GOCSPX-[A-Za-z0-9_-]{10,250}$/.test(secret)) fail("GOOGLE_OAUTH_CREDENTIALS_INVALID");
    register("GOOGLE_MAIL_CLIENT_ID", id, "production"); register("GOOGLE_MAIL_CLIENT_SECRET", secret, "production");
    console.log(JSON.stringify({ operation: OPERATION, status: "registered", environment: "production", names: ["GOOGLE_MAIL_CLIENT_ID", "GOOGLE_MAIL_CLIENT_SECRET"] })); return;
  }
  const live = OPERATION === "stripe-live-runtime", key = live ? payload.stripeLiveRestricted ?? "" : payload.stripeTestRestricted ?? "", accountId = live ? LIVE_ACCOUNT : TEST_ACCOUNT, target = live ? "production" : "preview";
  await verifyStripeKey(key, accountId, live);
  register("STRIPE_SECRET_KEY", key, target); register("STRIPE_ACCOUNT_ID", accountId, target, false);
  console.log(JSON.stringify({ operation: OPERATION, status: "registered", environment: target, names: ["STRIPE_SECRET_KEY", "STRIPE_ACCOUNT_ID"] }));
}
try { await main(); } catch (error) { console.log(JSON.stringify({ operation: OPERATIONS.has(OPERATION) ? OPERATION : "invalid", status: "failed", code: error instanceof TransferError ? error.code : "TRANSFER_FAILED", detailsRedacted: true })); process.exitCode = 1; }
