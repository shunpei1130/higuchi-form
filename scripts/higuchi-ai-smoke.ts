/** One billed, data-free request through the normal production AI budget ledger. */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { members, organizations, users } from "../src/lib/auth/schema";
import { OPERATOR_EMAIL, OPERATOR_ORGANIZATION, OPERATOR_SLUG } from "../src/lib/auth/operatorBootstrapPolicy";
import { inOrg, runInOrganization } from "../src/lib/tenancy/scope";
import { higuchiAiUsage } from "../src/lib/higuchi/jobs/schema";
import { completeWithOpenAi, getAiBudget } from "../src/lib/higuchi/openai";

const MODEL = "gpt-6-luna";
async function main() {
  if (process.env.HIGUCHI_AI_SMOKE_ALLOW !== "production-one-call" || process.env.HIGUCHI_MODE !== "live" || process.env.VERCEL_ENV !== "production" || process.env.NEON_PROJECT_ID !== "fancy-bird-03831252") throw new Error("AI_SMOKE_NOT_AUTHORIZED");
  const connection = new URL(process.env.DATABASE_URL ?? "");
  if (createHash("sha256").update(connection.hostname).digest("hex") !== "eacaef515b7de2f15d6dbad667235fe8786402a07bf27d3a6c01a8157091c269") throw new Error("AI_SMOKE_DATABASE_MISMATCH");
  const key = (await readFile(join(import.meta.dir, "..", "key.txt"), "utf8")).trim();
  if (!/^sk-[A-Za-z0-9_-]{20,250}$/.test(key)) throw new Error("AI_SMOKE_KEY_INVALID");
  process.env.OPENAI_API_KEY = key;
  process.env.HIGUCHI_OPENAI_MODEL = MODEL;
  process.env.HIGUCHI_AI_MONTHLY_USD = "20";
  const candidates = await db.select({ organizationId: organizations.id, name: organizations.name, slug: organizations.slug, metadata: organizations.metadata, role: members.role })
    .from(organizations).innerJoin(members, eq(members.organizationId, organizations.id)).innerJoin(users, eq(users.id, members.userId)).where(and(eq(users.email, OPERATOR_EMAIL), eq(organizations.slug, OPERATOR_SLUG)));
  const initial = candidates.filter(candidate => {
    let metadata: Record<string, unknown>; try { metadata = JSON.parse(candidate.metadata ?? "{}"); } catch { return false; }
    return candidate.name === OPERATOR_ORGANIZATION && candidate.role.split(",").includes("owner") && metadata.initial === true && metadata.bootstrapOperatorEmail === OPERATOR_EMAIL;
  });
  if (initial.length !== 1) throw new Error("AI_SMOKE_OPERATOR_NOT_READY");
  const result = await runInOrganization(initial[0].organizationId, () => db.transaction(async tx => {
    // The separate lock stops two invocations of this one-off smoke test. The
    // normal provider routine uses the second pool connection for its budget.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`higuchi-ai-first-smoke:${initial[0].organizationId}`}, 0))`);
    const existing = await tx.select({ id: higuchiAiUsage.id }).from(higuchiAiUsage).where(inOrg(higuchiAiUsage)).limit(1);
    if (existing.length) throw new Error("AI_SMOKE_ALREADY_ATTEMPTED");
    const before = await getAiBudget();
    const response = await completeWithOpenAi({ organizationId: initial[0].organizationId, systemPrompt: "Return only the object required by the JSON schema.", userPrompt: 'Return {"ok":true}.', schemaName: "higuchi_connection_smoke", jsonSchema: { type: "object", properties: { ok: { type: "boolean", enum: [true] } }, required: ["ok"], additionalProperties: false }, maxOutputTokens: 512 });
    const parsed: unknown = JSON.parse(response.text);
    if (!parsed || typeof parsed !== "object" || !("ok" in parsed) || parsed.ok !== true || Object.keys(parsed).length !== 1) throw new Error("AI_SMOKE_RESPONSE_INVALID");
    const after = await getAiBudget();
    return { success: true, model: MODEL, usageUSD: Number(((after.usedMicros - before.usedMicros) / 1_000_000).toFixed(8)), totalUsageUSD: Number((after.usedMicros / 1_000_000).toFixed(8)) };
  }));
  console.log(JSON.stringify(result));
}
try { await main(); }
catch (error) { console.log(JSON.stringify({ success: false, code: error instanceof Error && /^AI_SMOKE_[A-Z_]+$/.test(error.message) ? error.message : "AI_SMOKE_FAILED" })); process.exitCode = 1; }
finally { delete process.env.OPENAI_API_KEY; }
