/** Pure read-only Stripe catalog inspection shared by the authenticated operator route and CLI. */
const VERSION = "2026-10-28.endive", EVENT = "higuchi_email_sent_jpy_v1";
const PRODUCTION = { accountId: "acct_1SOtr4EXrauv37Rg", productId: "prod_higuchi_form_jpy_v1", meterId: "mtr_61Vm3gnLWQGJEStkr41EXrauv37RgU9o", priceId: "price_1UcfkwEXrauv37RgtUZw3SgF" };
const SANDBOX_ACCOUNT = "acct_1UcblRRGx64luiLk";
type Json = Record<string, unknown>;
export type InspectOptions = { target: "production" | "preview"; help: boolean };
export type InspectConfig = { target: InspectOptions["target"]; accountId: string; productId: string; meterId: string; priceId: string; restrictedKey: string; publishableKey: string; publishablePrefix: "pk_live_" | "pk_test_"; livemode: boolean };
export class InspectFailure extends Error {
  constructor(readonly code: string, readonly httpStatus?: number, readonly diagnostics: Json = {}) { super(code); }
}
export function inspectCheck(value: unknown, code: string, diagnostics: Json = {}): asserts value { if (!value) throw new InspectFailure(code, undefined, diagnostics); }
const check: typeof inspectCheck = inspectCheck;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const resourceId = (value: unknown) => typeof value === "string" ? value : typeof object(value).id === "string" ? String(object(value).id) : "";
export function validateInspectConfig(env: Record<string, string | undefined>, options: InspectOptions): InspectConfig {
  const livemode = options.target === "production", prefix = livemode ? "live" : "test";
  const publishableKey = env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || env.STRIPE_PUBLISHABLE_KEY || "";
  check(env.HIGUCHI_BILLING_CURRENCY === "JPY", "JPY_DEFAULT_REQUIRED");
  check(new RegExp(`^rk_${prefix}_[A-Za-z0-9]+$`).test(env.STRIPE_SECRET_KEY ?? ""), "MATCHING_RESTRICTED_KEY_REQUIRED");
  check(new RegExp(`^pk_${prefix}_[A-Za-z0-9]+$`).test(publishableKey), "MATCHING_PUBLISHABLE_KEY_REQUIRED");
  check(env.STRIPE_ACCOUNT_ID === (livemode ? PRODUCTION.accountId : SANDBOX_ACCOUNT), "ACCOUNT_ENV_MISMATCH");
  check(/^prod_[A-Za-z0-9_]+$/.test(env.STRIPE_JPY_PRODUCT_ID ?? "") && /^mtr_[A-Za-z0-9_]+$/.test(env.STRIPE_JPY_METER_ID ?? "") && /^price_[A-Za-z0-9_]+$/.test(env.STRIPE_JPY_PRICE_ID ?? ""), "JPY_CATALOG_ENV_REQUIRED");
  check(env.STRIPE_JPY_METER_EVENT_NAME === EVENT, "JPY_METER_EVENT_MISMATCH");
  if (livemode) check(env.STRIPE_JPY_PRODUCT_ID === PRODUCTION.productId && env.STRIPE_JPY_METER_ID === PRODUCTION.meterId && env.STRIPE_JPY_PRICE_ID === PRODUCTION.priceId, "PRODUCTION_CATALOG_IDENTITY_MISMATCH");
  return { target: options.target, accountId: env.STRIPE_ACCOUNT_ID!, productId: env.STRIPE_JPY_PRODUCT_ID!, meterId: env.STRIPE_JPY_METER_ID!, priceId: env.STRIPE_JPY_PRICE_ID!, restrictedKey: env.STRIPE_SECRET_KEY!, publishableKey, publishablePrefix: livemode ? "pk_live_" : "pk_test_", livemode };
}

/** Fixed four-resource GET allowlist. No caller can pass a verb, body or arbitrary Stripe path. */
export function createStripeReadOnlyReader(config: InspectConfig, fetcher: typeof fetch = fetch): (path: string) => Promise<Json> {
  check(new RegExp(`^rk_${config.livemode ? "live" : "test"}_[A-Za-z0-9]+$`).test(config.restrictedKey), "MATCHING_RESTRICTED_KEY_REQUIRED");
  const paths = new Set(["/account", `/products/${config.productId}`, `/prices/${config.priceId}`, `/billing/meters/${config.meterId}`]);
  const deadline = AbortSignal.timeout(100000);
  return async path => {
    check(paths.has(path), "STRIPE_PATH_NOT_READ_ONLY_ALLOWLISTED");
    const response = await fetcher(`https://api.stripe.com/v1${path}`, { method: "GET", headers: { Authorization: `Bearer ${config.restrictedKey}`, "Stripe-Version": VERSION }, redirect: "error", cache: "no-store", signal: AbortSignal.any([deadline, AbortSignal.timeout(25000)]) });
    if (!response.ok) throw new InspectFailure("STRIPE_READ_FAILED", response.status);
    return object(await response.json());
  };
}

export async function inspectJpyCatalog(config: InspectConfig, get = createStripeReadOnlyReader(config)) {
  const account = await get("/account");
  check(account.id === config.accountId, "STRIPE_ACCOUNT_IDENTITY_MISMATCH");
  const [product, price, meter] = await Promise.all([get(`/products/${config.productId}`), get(`/prices/${config.priceId}`), get(`/billing/meters/${config.meterId}`)]);
  const metadataMatches = (value: Json) => {
    const metadata = object(value.metadata);
    return metadata.higuchi_app === "higuchi-form" && metadata.higuchi_role === "email_usage_jpy_v1" && metadata.higuchi_currency === "JPY" && metadata.higuchi_price_version === "jpy-6-v1";
  };
  check(product.id === config.productId && product.active === true && product.livemode === config.livemode && metadataMatches(product), "JPY_PRODUCT_VERIFICATION_FAILED");
  const recurring = object(price.recurring);
  check(price.id === config.priceId && price.active === true && price.livemode === config.livemode && price.currency === "jpy" && price.unit_amount === 6 && resourceId(price.product) === config.productId && recurring.interval === "month" && recurring.usage_type === "metered" && resourceId(recurring.meter) === config.meterId && (!price.lookup_key || price.lookup_key === "higuchi_form_email_jpy_6_v1") && metadataMatches(price), "JPY_PRICE_VERIFICATION_FAILED");
  check(meter.id === config.meterId && meter.status === "active" && meter.event_name === EVENT && object(meter.default_aggregation).formula === "sum" && object(meter.value_settings).event_payload_key === "value" && object(meter.customer_mapping).type === "by_id" && object(meter.customer_mapping).event_payload_key === "stripe_customer_id" && (meter.livemode === undefined || meter.livemode === config.livemode), "JPY_METER_VERIFICATION_FAILED");
  return { status: "verified", target: config.target, mutation: false, resourcesRead: 4, accountId: config.accountId, currency: "JPY", unitAmountMinor: 6, priceVersion: "jpy-6-v1", productId: config.productId, priceId: config.priceId, meterId: config.meterId, eventName: EVENT, restrictedKey: true, publishableKeyPrefix: config.publishablePrefix, livemode: config.livemode, detailsRedacted: true } as const;
}

export function billingInspectionFailure(error: unknown) {
  return { status: "failed", mutation: false, code: error instanceof InspectFailure ? error.code : "INSPECTION_FAILED_DETAILS_REDACTED", ...(error instanceof InspectFailure ? error.diagnostics : {}), ...(error instanceof InspectFailure && error.httpStatus ? { httpStatus: error.httpStatus } : {}), detailsRedacted: true } as const;
}
