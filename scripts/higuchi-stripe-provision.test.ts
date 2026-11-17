import { expect, test } from "bun:test";
import { parseProvisionArguments, provisionCatalogEnvironment, validateProvisionKey } from "./higuchi-stripe-provision";
import { platformBillingCredentials } from "../src/lib/higuchi/billingCredentials";
import { provisionStripeBillingCatalog, type BillingDependencies } from "../src/lib/higuchi/providerBilling";

const testAccount = "acct_1UcblRRGx64luiLk", liveAccount = "acct_1SOtr4EXrauv37Rg";
const catalogArgs = ["--key-stdin", "--account-id", testAccount, "--catalog-only"];
test("JPY provisioning requires the explicit currency, catalog-only, approved account, stdin and live opt-in", () => {
  expect(parseProvisionArguments(catalogArgs)).toMatchObject({ currency: "USD", catalogOnly: true });
  expect(parseProvisionArguments([...catalogArgs, "--currency", "JPY"])).toMatchObject({ currency: "JPY", catalogOnly: true, webhookUrl: "" });
  for (const [args, code] of [
    [["--key-stdin", "--account-id", testAccount, "--currency", "JPY"], "JPY_REQUIRES_CATALOG_ONLY"],
    [[...catalogArgs, "--currency", "EUR"], "UNSUPPORTED_CURRENCY"],
    [[...catalogArgs, "--currency"], "MISSING_OPTION_VALUE"],
    [["--account-id", testAccount, "--catalog-only", "--currency", "JPY"], "KEY_STDIN_REQUIRED"],
    [["--key-stdin", "--account-id", "acct_unapproved", "--catalog-only", "--currency", "JPY"], "UNAPPROVED_ACCOUNT"],
    [["--key-stdin", "--account-id", liveAccount, "--catalog-only", "--currency", "JPY"], "LIVE_REQUIRES_EXPLICIT_FLAG"],
  ] as [string[], string][]) {
    try { parseProvisionArguments(args); throw new Error("Expected argument rejection"); }
    catch (error) { expect(error).toMatchObject({ code }); }
  }
  expect(parseProvisionArguments(["--key-stdin", "--account-id", liveAccount, "--catalog-only", "--currency", "JPY", "--allow-live"])).toMatchObject({ currency: "JPY", allowLive: true });
  expect(() => validateProvisionKey("sk_live_fixture", testAccount)).toThrow();
  expect(() => validateProvisionKey("rk_test_fixture", liveAccount)).toThrow();
});

test("CLI currency binds the catalog independently of ambient defaults and preserves the supplied key", () => {
  const ambient = { STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_ACCOUNT_ID: testAccount, HIGUCHI_BILLING_CURRENCY: "JPY", STRIPE_METER_EVENT_NAME: "wrong", STRIPE_JPY_METER_EVENT_NAME: "wrong" };
  const usd = platformBillingCredentials(provisionCatalogEnvironment(ambient, "USD"), "USD");
  const jpy = platformBillingCredentials(provisionCatalogEnvironment(ambient, "JPY"), "JPY");
  expect(usd).toMatchObject({ currency: "USD", stripeEventName: "higuchi_email_sent_v1", stripeSecretKey: "sk_test_fixture", priceVersion: "usd-4c-v1" });
  expect(jpy).toMatchObject({ currency: "JPY", stripeEventName: "higuchi_email_sent_jpy_v1", stripeSecretKey: "sk_test_fixture", priceVersion: "jpy-6-v1" });
  expect(ambient.STRIPE_METER_EVENT_NAME).toBe("wrong");
});

test("JPY catalog fixtures create only its product, meter and six-yen price, then reuse them without changing USD", async () => {
  type Json = Record<string, unknown>;
  const options = parseProvisionArguments([...catalogArgs, "--currency", "JPY"]);
  const credentials = platformBillingCredentials(provisionCatalogEnvironment({ STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_ACCOUNT_ID: testAccount }, options.currency), options.currency);
  const usdProduct = { id: "prod_usd", active: true, metadata: { higuchi_app: "higuchi-form", higuchi_role: "email_usage_v1" } };
  const usdMeter = { id: "mtr_usd", status: "active", event_name: "higuchi_email_sent_v1" };
  let product: Json | undefined, meter: Json | undefined, price: Json | undefined;
  const writes: { path: string; body: Json; requestKey?: string }[] = [];
  const request: BillingDependencies["request"] = async (_credentials, path, body, requestKey) => {
    if (body) {
      writes.push({ path, body, requestKey });
      if (path === "/products") return product = { ...body, id: "prod_jpy", active: true, livemode: false };
      if (path === "/billing/meters") return meter = { ...body, id: "mtr_jpy", status: "active", livemode: false };
      if (path === "/prices") return price = { ...body, id: "price_jpy", active: true, livemode: false };
      throw new Error(`Unexpected mutation: ${path}`);
    }
    if (path === "/account") return { id: testAccount };
    if (path.startsWith("/products?")) return { data: [usdProduct, ...(product ? [product] : [])], has_more: false };
    if (path.startsWith("/billing/meters?")) return { data: [usdMeter, ...(meter ? [meter] : [])], has_more: false };
    if (path.startsWith("/prices?")) { expect(path).toContain("higuchi_form_email_jpy_6_v1"); return { data: price ? [price] : [], has_more: false }; }
    if (path === "/products/prod_jpy" && product) return product;
    if (path === "/billing/meters/mtr_jpy" && meter) return meter;
    if (path === "/prices/price_jpy" && price) return price;
    throw new Error(`Unexpected read: ${path}`);
  };
  const dependencies = { platform: () => credentials, request };
  const catalog = await provisionStripeBillingCatalog({ allowLive: options.allowLive }, dependencies);
  expect(catalog).toEqual({ productId: "prod_jpy", meterId: "mtr_jpy", priceId: "price_jpy", eventName: "higuchi_email_sent_jpy_v1" });
  expect(writes.map(write => write.path)).toEqual(["/products", "/billing/meters", "/prices"]);
  expect(product).toMatchObject({ metadata: { higuchi_app: "higuchi-form", higuchi_role: "email_usage_jpy_v1", higuchi_currency: "JPY", higuchi_price_version: "jpy-6-v1" } });
  expect(meter).toMatchObject({ event_name: "higuchi_email_sent_jpy_v1", default_aggregation: { formula: "sum" }, value_settings: { event_payload_key: "value" }, customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" } });
  expect(price).toMatchObject({ currency: "jpy", unit_amount: 6, product: "prod_jpy", lookup_key: "higuchi_form_email_jpy_6_v1", recurring: { interval: "month", usage_type: "metered", meter: "mtr_jpy" }, metadata: { higuchi_app: "higuchi-form", higuchi_currency: "JPY", higuchi_price_version: "jpy-6-v1" } });
  expect(writes.every(write => write.requestKey?.endsWith("jpy-v1"))).toBe(true);
  expect(await provisionStripeBillingCatalog({ allowLive: false }, dependencies)).toEqual(catalog);
  expect(writes).toHaveLength(3);
  expect(usdProduct).toMatchObject({ id: "prod_usd", metadata: { higuchi_role: "email_usage_v1" } });
});

test("the adapter also rejects live catalog provisioning before requests without allow-live", async () => {
  const credentials = platformBillingCredentials(provisionCatalogEnvironment({ STRIPE_SECRET_KEY: "sk_live_fixture", STRIPE_ACCOUNT_ID: liveAccount }, "JPY"), "JPY");
  let calls = 0;
  await expect(provisionStripeBillingCatalog({}, { platform: () => credentials, request: async () => { calls++; throw new Error("Must not request"); } })).rejects.toThrow();
  expect(calls).toBe(0);
});
