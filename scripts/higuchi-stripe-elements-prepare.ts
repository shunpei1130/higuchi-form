/** Explicit sandbox-only Session preparation; never confirms a card or payment. */
import { createHash, randomUUID } from "node:crypto";
import type { BillingCredentials } from "../src/lib/higuchi/billingCredentials";
import type { BillingDependencies } from "../src/lib/higuchi/providerBilling";
import { billingInspectionFailure } from "../src/lib/higuchi/billingInspection";
import { INSPECT_ENV_NAMES, inspectJpyCatalog, loadInspectEnvironment, readVercelInspectorJson, validateInspectConfig, type InspectConfig } from "./higuchi-stripe-inspect";

const ACCOUNT = "acct_1UcblRRGx64luiLk", VERSION = "2026-10-28.endive";
type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const id = (value: unknown) => typeof value === "string" ? value : typeof object(value).id === "string" ? String(object(value).id) : "";
class PrepareFailure extends Error {
  constructor(readonly code: string, readonly details: Json = {}) { super(code); }
}
function check(value: unknown, code: string): asserts value { if (!value) throw new PrepareFailure(code); }
export function parseElementsPrepareArguments(args: string[]): { help: boolean; keyStdin: boolean } {
  if (args.length === 1 && args[0] === "--help") return { help: true, keyStdin: false };
  const operations = args.filter(argument => argument !== "--key-stdin");
  check(args.length === 3 && operations.length === 2 && operations[0] === "preview" && operations[1] === "prepare-elements", "EXPLICIT_SANDBOX_PREPARE_AND_KEY_STDIN_REQUIRED");
  return { help: false, keyStdin: true };
}
export async function readSandboxRestrictedKey(input: AsyncIterable<Uint8Array | string> = process.stdin, isTTY = process.stdin.isTTY): Promise<string> {
  check(!isTTY, "PIPE_RESTRICTED_TEST_KEY_WITHOUT_ECHO");
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of input) { const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk); length += bytes.length; check(length <= 16384, "KEY_INPUT_TOO_LARGE"); chunks.push(bytes); }
  const key = Buffer.concat(chunks).toString("utf8").trim();
  check(/^rk_test_[A-Za-z0-9]+$/.test(key), "RESTRICTED_TEST_KEY_REQUIRED");
  return key;
}
export function validatedSandboxReturnOrigin(input: string): string {
  let url: URL; try { url = new URL(input); } catch { throw new PrepareFailure("PREVIEW_RETURN_ORIGIN_REQUIRED"); }
  check(url.protocol === "https:" && !url.username && !url.password && url.hostname.startsWith("form-higuchi-") && url.hostname.endsWith(".vercel.app"), "PREVIEW_RETURN_ORIGIN_REQUIRED");
  return url.origin;
}

export async function prepareSandboxElements(config: InspectConfig, returnOrigin: string, fetcher: typeof fetch = fetch) {
  check(config.target === "preview" && config.livemode === false && config.accountId === ACCOUNT && /^rk_test_[A-Za-z0-9]+$/.test(config.restrictedKey) && /^pk_test_[A-Za-z0-9]+$/.test(config.publishableKey), "DEDICATED_SANDBOX_RESTRICTED_KEY_REQUIRED");
  const origin = validatedSandboxReturnOrigin(returnOrigin), runId = randomUUID(), organizationId = randomUUID();
  const fixture = { higuchi_app: "higuchi-form", higuchi_organization: organizationId, higuchi_currency: "JPY", higuchi_price_version: "jpy-6-v1", higuchi_fixture: "sandbox_elements_prepare", higuchi_test_run: runId };
  const credentials: BillingCredentials = { currency: "JPY", priceVersion: "jpy-6-v1", stripeSecretKey: config.restrictedKey, stripePublishableKey: config.publishableKey, stripeWebhookSecret: "", stripeAccountId: ACCOUNT, stripeProductId: config.productId, stripeMeterId: config.meterId, stripePriceId: config.priceId, stripeEventName: "higuchi_email_sent_jpy_v1", stripeCustomerId: "", stripeSubscriptionId: "", livemode: false };
  const sessions = new Map<string, Json>(), modes = new Set<string>();
  const deadline = AbortSignal.timeout(180000);
  let customerId = "", phase = "catalog", expired = 0, customerDeleted = false, cleaning = false, failure: unknown;
  const cleanupFailures: string[] = [];
  const previousOrigin = process.env.BETTER_AUTH_URL;
  const api = await import("../src/lib/higuchi/providerBilling");
  const readPaths = new Set(["/account", `/products/${config.productId}`, `/prices/${config.priceId}`, `/billing/meters/${config.meterId}`]);

  const stripe = async (method: "GET" | "POST" | "DELETE", path: string, body?: Json, requestKey?: string): Promise<Json> => {
    if (method === "GET") check(readPaths.has(path) || customerId && path === `/customers/${customerId}`, "READ_PATH_REFUSED");
    else if (method === "POST" && path === "/customers") check(!customerId && body?.email === undefined && object(body?.metadata).higuchi_test_run === runId && object(body?.metadata).higuchi_fixture === fixture.higuchi_fixture, "FIXTURE_CUSTOMER_REQUIRED");
    else if (method === "POST" && path === "/checkout/sessions") {
      const metadata = object(body?.metadata), mode = String(body?.mode), line = object(Array.isArray(body?.line_items) ? body?.line_items[0] : null), price = object(line.price_data);
      check(customerId && body?.customer === customerId && body.ui_mode === "elements" && body.return_url === `${origin}/app/billing` && ["setup", "payment"].includes(mode) && !modes.has(mode) && modes.size < 2, "ELEMENTS_SESSION_SCOPE_REQUIRED");
      check(metadata.higuchi_app === fixture.higuchi_app && metadata.higuchi_organization === organizationId && metadata.higuchi_currency === "JPY" && metadata.higuchi_price_version === "jpy-6-v1" && object(body.automatic_tax).enabled !== true, "ELEMENTS_METADATA_REQUIRED");
      check(mode === "setup" ? body.currency === "jpy" : Array.isArray(body.line_items) && body.line_items.length === 1 && line.quantity === 1 && price.currency === "jpy" && price.unit_amount === 4500 && object(body.payment_intent_data).setup_future_usage === "off_session", "JPY_SESSION_AMOUNT_REQUIRED");
      modes.add(mode);
      body = { ...body, metadata: { ...metadata, higuchi_fixture: fixture.higuchi_fixture, higuchi_test_run: runId } };
      if (mode === "payment") body.payment_intent_data = { ...object(body.payment_intent_data), metadata: { ...object(object(body.payment_intent_data).metadata), higuchi_fixture: fixture.higuchi_fixture, higuchi_test_run: runId } };
    } else if (method === "POST" && path.endsWith("/expire")) check([...sessions.keys()].some(sessionId => path === `/checkout/sessions/${sessionId}/expire`) && body && !Object.keys(body).length, "OWN_SESSION_EXPIRATION_REQUIRED");
    else if (method === "DELETE") check(customerId && path === `/customers/${customerId}`, "OWN_CUSTOMER_DELETE_REQUIRED");
    else throw new PrepareFailure("STRIPE_MUTATION_REFUSED");
    const response = await fetcher(`https://api.stripe.com/v1${path}`, { method, headers: { Authorization: `Bearer ${config.restrictedKey}`, "Stripe-Version": VERSION, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...(requestKey ? { "Idempotency-Key": `higuchi-prepare-${createHash("sha256").update(requestKey).digest("hex")}` } : {}) }, body: body ? api.stripeForm(body) : undefined, redirect: "error", cache: "no-store", signal: cleaning ? AbortSignal.timeout(20000) : AbortSignal.any([deadline, AbortSignal.timeout(20000)]) });
    const result = object(await response.json().catch(() => null));
    if (!response.ok) {
      const error = object(result.error), code = String(error.code), parameter = String(error.param);
      const safeCodes = ["parameter_missing", "parameter_unknown", "parameter_invalid_integer", "parameter_invalid_empty", "invalid_enum", "resource_missing", "permission_denied", "account_invalid"];
      const safeParameters = ["ui_mode", "mode", "currency", "integration_identifier", "return_url", "customer", "line_items", "payment_intent_data", "metadata"];
      throw new PrepareFailure("STRIPE_REQUEST_FAILED", { httpStatus: response.status, ...(safeCodes.includes(code) ? { stripeCode: code } : {}), ...(safeParameters.includes(parameter) ? { parameter } : {}) });
    }
    check(result.livemode !== true, "LIVE_RESPONSE_REFUSED");
    if (method === "POST" && path === "/customers") { check(/^cus_[A-Za-z0-9]+$/.test(id(result)), "FIXTURE_CUSTOMER_RECEIPT_INVALID"); customerId = id(result); }
    if (method === "POST" && path === "/checkout/sessions") { check(/^cs_test_[A-Za-z0-9]+$/.test(id(result)), "SESSION_RECEIPT_INVALID"); sessions.set(id(result), result); }
    return result;
  };
  const request: BillingDependencies["request"] = async (current, path, body, requestKey) => {
    check(current.stripeAccountId === ACCOUNT && current.livemode === false && current.stripeSecretKey === config.restrictedKey, "SANDBOX_SCOPE_LOST");
    return stripe(body ? "POST" : "GET", path, body, requestKey);
  };
  try {
    await inspectJpyCatalog(config, path => stripe("GET", path));
    phase = "customer";
    const customer = await stripe("POST", "/customers", { name: "higuchi-form sandbox Elements fixture", metadata: { ...fixture, higuchi_purpose: "sandbox_elements_prepare" } }, `customer:${runId}`);
    check(object(customer.metadata).higuchi_test_run === runId && object(customer.metadata).higuchi_organization === organizationId, "FIXTURE_CUSTOMER_METADATA_INVALID");
    credentials.stripeCustomerId = customerId;
    const dependencies: Partial<BillingDependencies> = { request, platform: () => credentials, credentials: async org => { check(org === organizationId, "FIXTURE_ORGANIZATION_REQUIRED"); return credentials; }, saveConnection: async () => { throw new PrepareFailure("DATABASE_MAPPING_REFUSED"); }, organizationForCustomer: async () => null, mode: () => "live" };
    // Only a non-secret return URL is changed temporarily; no credentials enter env/files.
    process.env.BETTER_AUTH_URL = origin;
    for (const mode of ["setup", "payment"] as const) {
      phase = `${mode}_session`;
      const input = { organizationId, returnUrl: `${origin}/app/billing`, requestId: randomUUID(), currency: "JPY" as const, uiMode: "elements" as const };
      const result = mode === "setup" ? await api.createBillingSetup(input, dependencies) : await api.createBillingCheckout({ ...input, amountCents: 4500, firstPaymentBonus: true }, dependencies);
      const session = sessions.get(result.sessionId)!;
      check(session && session.mode === mode && session.ui_mode === "elements" && session.status === "open" && session.currency === "jpy" && id(session.customer) === customerId && result.customerId === customerId, "SESSION_CONTRACT_INVALID");
      check(typeof result.clientSecret === "string" && result.clientSecret.startsWith(`${result.sessionId}_secret_`) && result.clientSecret.length > result.sessionId.length + 8 && result.publishableKey === config.publishableKey && result.currency === "JPY" && result.priceVersion === "jpy-6-v1", "ELEMENTS_CLIENT_CONFIGURATION_INVALID");
      if (mode === "payment") check(session.amount_total === 4500 && session.payment_status === "unpaid", "UNCONFIRMED_PAYMENT_REQUIRED");
    }
  } catch (error) { failure = error; }
  finally {
    cleaning = true;
    if (previousOrigin === undefined) delete process.env.BETTER_AUTH_URL; else process.env.BETTER_AUTH_URL = previousOrigin;
    for (const sessionId of sessions.keys()) {
      try { const receipt = await stripe("POST", `/checkout/sessions/${sessionId}/expire`, {}); check(receipt.id === sessionId && receipt.status === "expired", "EXPIRATION_RECEIPT_INVALID"); expired++; }
      catch { cleanupFailures.push(`session:${sessionId}`); }
    }
    if (customerId) {
      try {
        const owned = await stripe("GET", `/customers/${customerId}`), metadata = object(owned.metadata);
        check(metadata.higuchi_test_run === runId && metadata.higuchi_fixture === fixture.higuchi_fixture && metadata.higuchi_organization === organizationId, "CLEANUP_OWNERSHIP_INVALID");
        const receipt = await stripe("DELETE", `/customers/${customerId}`); check(receipt.id === customerId && receipt.deleted === true, "DELETE_RECEIPT_INVALID"); customerDeleted = true;
      } catch { cleanupFailures.push(`customer:${customerId}`); }
    }
  }
  const cleanup = { sessionsPrepared: sessions.size, sessionsExpired: expired, customerDeleted, ...(cleanupFailures.length ? { manualCleanup: cleanupFailures } : {}) };
  if (failure || cleanupFailures.length) throw new PrepareFailure(failure instanceof PrepareFailure ? failure.code : failure ? "SESSION_PREPARATION_FAILED_DETAILS_REDACTED" : "FIXTURE_CLEANUP_INCOMPLETE", { phase, runId, ...cleanup, ...(failure instanceof PrepareFailure ? failure.details : {}) });
  return { status: "prepared", accountId: ACCOUNT, mode: "test", currency: "JPY", uiMode: "elements", paymentAmountMinor: 4500, runId, publishableKeyPrefix: "pk_test_", ...cleanup, cardConfirmation: "not_performed", payment: "not_performed", webhook: "not_exercised", databaseMapping: "not_created", creditGrant: "not_created", subscription: "not_created", meterEvent: "not_sent", limitation: "Session preparation only; card authentication, payment completion and signed webhook handling still require separate verification.", detailsRedacted: true } as const;
}

async function main() {
  const options = parseElementsPrepareArguments(process.argv.slice(2));
  if (options.help) { console.log("bun --conditions=react-server scripts/higuchi-stripe-elements-prepare.ts preview prepare-elements --key-stdin\nAccepts only a restricted test key via stdin; reads non-secret Preview settings from Vercel. Prepares and expires two unconfirmed Sessions, then deletes its fixture Customer."); return; }
  const key = await readSandboxRestrictedKey();
  const target = { target: "preview", help: false } as const;
  const env = loadInspectEnvironment(target, readVercelInspectorJson, INSPECT_ENV_NAMES.filter(name => name !== "STRIPE_SECRET_KEY"));
  env.STRIPE_SECRET_KEY = key;
  console.log(JSON.stringify(await prepareSandboxElements(validateInspectConfig(env, target), process.env.HIGUCHI_SANDBOX_RETURN_ORIGIN??"")));
}
if (import.meta.main) {
  try { await main(); } catch (error) { console.error(JSON.stringify({ status: "failed", mode: "test", code: error instanceof PrepareFailure ? error.code : "PREPARATION_FAILED_DETAILS_REDACTED", ...(error instanceof PrepareFailure ? error.details : {inspection:billingInspectionFailure(error)}), detailsRedacted: true })); process.exitCode = 1; }
}
