import { expect, test } from "bun:test";
import { parseElementsPrepareArguments, prepareSandboxElements, readSandboxRestrictedKey, validatedSandboxReturnOrigin } from "./higuchi-stripe-elements-prepare";
import { validateInspectConfig } from "./higuchi-stripe-inspect";

const config = validateInspectConfig({
  HIGUCHI_BILLING_CURRENCY: "JPY", STRIPE_SECRET_KEY: "rk_test_fixture", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_fixture",
  STRIPE_ACCOUNT_ID: "acct_1UcblRRGx64luiLk", STRIPE_JPY_PRODUCT_ID: "prod_VdxrYBqw9CaWHC", STRIPE_JPY_METER_ID: "mtr_test_61Vm3srb96xP8Y1BM41RGx64luiLkTpg", STRIPE_JPY_PRICE_ID: "price_1UcfvVRGx64luiLkwc9DZDYa", STRIPE_JPY_METER_EVENT_NAME: "higuchi_email_sent_jpy_v1",
}, { target: "preview", help: false });
const origin = "https://form-higuchi-fixture.vercel.app";
type Json = Record<string, unknown>;
function transport(options: { failPayment?: boolean; failDelete?: boolean } = {}) {
  const calls: { method: string; path: string; form: URLSearchParams }[] = [];
  const metadata = { higuchi_app: "higuchi-form", higuchi_role: "email_usage_jpy_v1", higuchi_currency: "JPY", higuchi_price_version: "jpy-6-v1" };
  let customer: Json | undefined;
  const sessions = new Map<string, Json>();
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace(/^\/v1/, ""), method = init?.method ?? "GET", form = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ method, path, form });
    const fields = (prefix: string) => Object.fromEntries([...form.entries()].filter(([key]) => key.startsWith(`${prefix}[`)).map(([key, value]) => [key.slice(prefix.length + 1, -1), value]));
    if (method === "GET") {
      if (path === "/account") return Response.json({ id: config.accountId });
      if (path === `/products/${config.productId}`) return Response.json({ id: config.productId, active: true, livemode: false, metadata });
      if (path === `/prices/${config.priceId}`) return Response.json({ id: config.priceId, active: true, livemode: false, metadata, currency: "jpy", unit_amount: 6, product: config.productId, recurring: { interval: "month", usage_type: "metered", meter: config.meterId } });
      if (path === `/billing/meters/${config.meterId}`) return Response.json({ id: config.meterId, status: "active", event_name: "higuchi_email_sent_jpy_v1", default_aggregation: { formula: "sum" }, value_settings: { event_payload_key: "value" }, customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" } });
      if (path === "/customers/cus_fixture123" && customer) return Response.json(customer);
    }
    if (method === "POST" && path === "/customers") {
      customer = { id: "cus_fixture123", livemode: false, metadata: fields("metadata") };
      return Response.json(customer);
    }
    if (method === "POST" && path === "/checkout/sessions") {
      if (options.failPayment && form.get("mode") === "payment") return Response.json({ error: { code: "parameter_unknown", param: "ui_mode", message: `Never log ${config.restrictedKey}` } }, { status: 400 });
      const mode = form.get("mode"), sessionId = `cs_test_${mode}Fixture`;
      const session = { id: sessionId, mode, ui_mode: form.get("ui_mode"), customer: form.get("customer"), status: "open", currency: "jpy", livemode: false, amount_total: mode === "payment" ? 4500 : null, payment_status: mode === "payment" ? "unpaid" : "no_payment_required", client_secret: `${sessionId}_secret_fixture`, metadata: fields("metadata") };
      sessions.set(sessionId, session); return Response.json(session);
    }
    if (method === "POST" && path.endsWith("/expire")) {
      const sessionId = path.split("/")[3], session = sessions.get(sessionId)!;
      session.status = "expired"; return Response.json(session);
    }
    if (method === "DELETE" && path === "/customers/cus_fixture123") return options.failDelete ? Response.json({ error: { code: "permission_denied" } }, { status: 403 }) : Response.json({ id: "cus_fixture123", deleted: true });
    throw new Error(`Unexpected protocol operation ${method} ${path}`);
  }) as typeof fetch;
  return { fetcher, calls, sessions };
}

test("sandbox preparation rejects production, full keys, non-Preview origins and unsupported operations before requests", async () => {
  expect(parseElementsPrepareArguments(["preview", "prepare-elements", "--key-stdin"])).toEqual({ help: false, keyStdin: true });
  for (const args of [["--production", "prepare-elements", "--key-stdin"], ["preview", "pay"], [], ["preview", "prepare-elements"], ["preview", "prepare-elements", "--key-stdin", "--key-stdin"]]) expect(() => parseElementsPrepareArguments(args)).toThrow();
  for (const url of ["https://form-higuchi.vercel.app", "https://other-project.vercel.app", "http://form-higuchi-fixture.vercel.app", "https://form-higuchi-fixture.vercel.app.evil.example", "https://user:secret@form-higuchi-fixture.vercel.app"]) expect(() => validatedSandboxReturnOrigin(url)).toThrow();
  let calls = 0;
  const fetcher = (async () => { calls++; throw new Error("Must not request"); }) as unknown as typeof fetch;
  for (const patch of [{ target: "production" as const }, { livemode: true }, { restrictedKey: "sk_test_fixture" }, { accountId: "acct_other" }]) await expect(prepareSandboxElements({ ...config, ...patch }, origin, fetcher)).rejects.toThrow();
  expect(calls).toBe(0);
});

test("stdin accepts only a bounded restricted test key and rejects full/live keys without echo", async () => {
  const input = async function* (key: string) { yield key; };
  expect(await readSandboxRestrictedKey(input("rk_test_fixture\n"), false)).toBe("rk_test_fixture");
  for (const key of ["sk_test_fixture", "rk_live_fixture", "sk_live_fixture", "x".repeat(16385)]) await expect(readSandboxRestrictedKey(input(key), false)).rejects.toThrow();
  await expect(readSandboxRestrictedKey(input("rk_test_fixture"), true)).rejects.toThrow();
});

test("real provider code prepares only two unconfirmed Elements Sessions and removes every fixture", async () => {
  const fixture = transport(), previousOrigin = process.env.BETTER_AUTH_URL;
  const result = await prepareSandboxElements(config, origin, fixture.fetcher);
  expect(result).toMatchObject({ status: "prepared", currency: "JPY", paymentAmountMinor: 4500, sessionsPrepared: 2, sessionsExpired: 2, customerDeleted: true, payment: "not_performed", databaseMapping: "not_created", webhook: "not_exercised" });
  expect(process.env.BETTER_AUTH_URL).toBe(previousOrigin);
  const writes = fixture.calls.filter(call => call.method !== "GET");
  expect(writes.map(call => `${call.method} ${call.path}`)).toEqual(["POST /customers", "POST /checkout/sessions", "POST /checkout/sessions", "POST /checkout/sessions/cs_test_setupFixture/expire", "POST /checkout/sessions/cs_test_paymentFixture/expire", "DELETE /customers/cus_fixture123"]);
  const payment = writes[2].form;
  expect(payment.get("ui_mode")).toBe("elements"); expect(payment.get("locale")).toBe("ja"); expect(payment.get("line_items[0][price_data][unit_amount]")).toBe("4500");
  expect(payment.get("payment_intent_data[setup_future_usage]")).toBe("off_session"); expect(payment.get("automatic_tax[enabled]")).not.toBe("true");
  expect(writes[0].form.has("email")).toBe(false); expect(writes[0].form.get("metadata[higuchi_fixture]")).toBe("sandbox_elements_prepare");
  expect([...fixture.sessions.values()].every(session => session.status === "expired")).toBe(true);
  const output = JSON.stringify(result); expect(output).not.toContain(config.restrictedKey); expect(output).not.toContain(config.publishableKey); expect(output).not.toContain("_secret_");
  expect(fixture.calls.some(call => /(?:confirm|\/pay|setup_intents|payment_intents|credit_grants|subscriptions|meter_events)/.test(call.path))).toBe(false);
});

test("failed payment Session creation still expires setup and deletes the owned fixture without leaking errors", async () => {
  const fixture = transport({ failPayment: true });
  try { await prepareSandboxElements(config, origin, fixture.fetcher); throw new Error("Expected failure"); }
  catch (error) {
    expect(error).toMatchObject({ code: "STRIPE_REQUEST_FAILED", details: { httpStatus: 400, parameter: "ui_mode", sessionsPrepared: 1, sessionsExpired: 1, customerDeleted: true } });
    expect(JSON.stringify(error)).not.toContain(config.restrictedKey);
  }
  expect(fixture.calls.at(-1)?.method).toBe("DELETE");
});

test("cleanup failures retain only fixture identifiers for manual cleanup", async () => {
  const fixture = transport({ failDelete: true });
  await expect(prepareSandboxElements(config, origin, fixture.fetcher)).rejects.toMatchObject({ code: "FIXTURE_CLEANUP_INCOMPLETE", details: { sessionsExpired: 2, customerDeleted: false, manualCleanup: ["customer:cus_fixture123"] } });
});
