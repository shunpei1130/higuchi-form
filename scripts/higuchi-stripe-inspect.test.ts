import { expect, test } from "bun:test";
import { createStripeReadOnlyReader, inspectJpyCatalog, loadInspectConfig, parseInspectArguments, validateInspectConfig } from "./higuchi-stripe-inspect";

const env = {
  STRIPE_SECRET_KEY: "rk_live_fixture", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_fixture", HIGUCHI_BILLING_CURRENCY: "JPY",
  STRIPE_ACCOUNT_ID: "acct_1SOtr4EXrauv37Rg", STRIPE_JPY_PRODUCT_ID: "prod_higuchi_form_jpy_v1",
  STRIPE_JPY_METER_ID: "mtr_61Vm3gnLWQGJEStkr41EXrauv37RgU9o", STRIPE_JPY_PRICE_ID: "price_1UcfkwEXrauv37RgtUZw3SgF",
  STRIPE_JPY_METER_EVENT_NAME: "higuchi_email_sent_jpy_v1",
};
const options = { target: "production", help: false } as const;
const metadata = { higuchi_app: "higuchi-form", higuchi_role: "email_usage_jpy_v1", higuchi_currency: "JPY", higuchi_price_version: "jpy-6-v1" };
const fixtures = () => ({
  "/account": { id: env.STRIPE_ACCOUNT_ID },
  [`/products/${env.STRIPE_JPY_PRODUCT_ID}`]: { id: env.STRIPE_JPY_PRODUCT_ID, active: true, livemode: true, metadata },
  [`/prices/${env.STRIPE_JPY_PRICE_ID}`]: { id: env.STRIPE_JPY_PRICE_ID, active: true, livemode: true, metadata, currency: "jpy", unit_amount: 6, product: env.STRIPE_JPY_PRODUCT_ID, recurring: { interval: "month", usage_type: "metered", meter: env.STRIPE_JPY_METER_ID } },
  [`/billing/meters/${env.STRIPE_JPY_METER_ID}`]: { id: env.STRIPE_JPY_METER_ID, status: "active", event_name: env.STRIPE_JPY_METER_EVENT_NAME, default_aggregation: { formula: "sum" }, value_settings: { event_payload_key: "value" }, customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" } },
});

test("inspection requires explicit production or preview and accepts no keys, files or write operations", () => {
  expect(parseInspectArguments(["--production", "inspect"])).toEqual(options);
  expect(parseInspectArguments(["preview", "inspect"]).target).toBe("preview");
  for (const args of [[], ["inspect"], ["production", "inspect"], ["--production", "setup"], ["--production", "inspect", "--key-stdin"], ["--env-file", ".env"], ["--production", "inspect", "--allow-live"]]) expect(() => parseInspectArguments(args)).toThrow();
  for (const change of [
    { STRIPE_SECRET_KEY: "sk_live_fixture" }, { STRIPE_SECRET_KEY: "rk_test_fixture" },
    { NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_fixture" }, { HIGUCHI_BILLING_CURRENCY: "USD" },
    { STRIPE_ACCOUNT_ID: "acct_other" }, { STRIPE_JPY_PRODUCT_ID: "prod_other" },
    { STRIPE_JPY_METER_ID: "mtr_other" }, { STRIPE_JPY_PRICE_ID: "price_other" },
    { STRIPE_JPY_METER_EVENT_NAME: "higuchi_email_sent_v1" },
  ]) expect(() => validateInspectConfig({ ...env, ...change }, options)).toThrow();
  expect(validateInspectConfig({ ...env, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: undefined, STRIPE_PUBLISHABLE_KEY: "pk_live_fixture" }, options).publishablePrefix).toBe("pk_live_");
});

test("environment credentials are read individually from the exact authenticated Vercel project", () => {
  const paths: string[] = [];
  const cli = (path: string) => {
    paths.push(path);
    expect(path).toContain("prj_Jfz4TuWBMR7mPl59pIaISCCve6JV"); expect(path).toContain("team_Iic3HLNmnGRA51i7VKtiOMmN");
    if (path.startsWith("/v9/")) return { id: "prj_Jfz4TuWBMR7mPl59pIaISCCve6JV", name: "form-higuchi", accountId: "team_Iic3HLNmnGRA51i7VKtiOMmN" };
    if (path.startsWith("/v10/")) return { envs: Object.keys(env).flatMap(key => [
      { id: key, key, type: key === "STRIPE_SECRET_KEY" ? "sensitive" : "plain", target: ["production"] },
      { id: `${key}-preview`, key, target: ["preview"] },
      { id: `${key}-branch`, key, target: ["production"], gitBranch: "feature" },
    ]) };
    const name = decodeURIComponent(path.split("/env/")[1].split("?")[0]);
    return { key: name, value: env[name as keyof typeof env], type: name === "STRIPE_SECRET_KEY" ? "sensitive" : "plain", decrypted: name === "STRIPE_SECRET_KEY" };
  };
  expect(loadInspectConfig(options, cli)).toMatchObject({ accountId: env.STRIPE_ACCOUNT_ID, restrictedKey: env.STRIPE_SECRET_KEY, target: "production" });
  expect(paths).toHaveLength(10);
  expect(paths.filter(path => path.startsWith("/v1/"))).toHaveLength(8);
  expect(() => loadInspectConfig(options, () => ({ id: "wrong-project" }))).toThrow();
  try {
    loadInspectConfig(options, path => { const value = cli(path); return path.includes("/env/STRIPE_SECRET_KEY?") ? { ...value, decrypted: false } : value; });
    throw new Error("Expected secret decryption rejection");
  } catch (error) {
    expect(error).toMatchObject({ code: "INDIVIDUAL_ENV_READ_INVALID", diagnostics: { stage: "individual_env_read", envKey: "STRIPE_SECRET_KEY", decrypted: false, returnedKeyMatches: true } });
    expect(JSON.stringify(error)).not.toContain(env.STRIPE_SECRET_KEY); expect(JSON.stringify(error)).not.toContain(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
  }
});

test("the inspector makes precisely four GET requests and emits a constructed secret-free summary", async () => {
  const config = validateInspectConfig(env, options), values = fixtures(), requests: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace(/^\/v1/, ""); requests.push(path);
    expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined(); expect(init?.redirect).toBe("error");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${env.STRIPE_SECRET_KEY}`);
    return Response.json(values[path as keyof typeof values]);
  }) as typeof fetch;
  const reader = createStripeReadOnlyReader(config, fetcher);
  const result = await inspectJpyCatalog(config, reader);
  expect(requests).toHaveLength(4);
  expect(result).toMatchObject({ status: "verified", mutation: false, currency: "JPY", unitAmountMinor: 6, resourcesRead: 4, publishableKeyPrefix: "pk_live_", livemode: true });
  const summary = JSON.stringify(result);
  expect(summary).not.toContain(env.STRIPE_SECRET_KEY); expect(summary).not.toContain(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
  await expect(reader("/customers")).rejects.toThrow(); await expect(reader("/checkout/sessions")).rejects.toThrow();
  expect(requests).toHaveLength(4);
  expect(() => createStripeReadOnlyReader({ ...config, restrictedKey: "sk_live_fixture" }, fetcher)).toThrow();
});

test("account, amount, currency, catalog and metadata mismatches fail closed", async () => {
  const config = validateInspectConfig(env, options);
  for (const [path, patch] of [
    ["/account", { id: "acct_other" }],
    [`/products/${config.productId}`, { metadata: { ...metadata, higuchi_currency: "USD" } }],
    [`/prices/${config.priceId}`, { unit_amount: 4 }],
    [`/prices/${config.priceId}`, { currency: "usd" }],
    [`/prices/${config.priceId}`, { livemode: false }],
    [`/prices/${config.priceId}`, { metadata: { ...metadata, higuchi_price_version: "old" } }],
    [`/billing/meters/${config.meterId}`, { event_name: "higuchi_email_sent_v1" }],
  ] as [string, Record<string, unknown>][]) {
    const values = fixtures() as Record<string, Record<string, unknown>>;
    values[path] = { ...values[path], ...patch };
    await expect(inspectJpyCatalog(config, async resource => values[resource])).rejects.toThrow();
  }
});
