import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// One SQL source serves fresh installs and upgrades, including current upstream
// migrations absent from the older dump. The Docker runner only needs Bun + db/.
const marker = "-- higuchi-form: additive upgrade contract";
const snapshot = await readFile(join(import.meta.dir, "..", "..", "db", "schema.sql"), "utf8");
const boundary = snapshot.indexOf(marker);
if (boundary < 0) throw new Error("The higuchi-form additive upgrade contract is missing from db/schema.sql");
const upgrade = snapshot.slice(boundary);

const higuchiColumns: Record<string, string[]> = {
  higuchi_workspaces: ["organization_id", "state", "updated_at"],
  higuchi_jobs: ["id", "organization_id", "kind", "entity_id", "idempotency_key", "payload", "status", "run_after", "locked_by", "lease_until", "attempts", "max_attempts", "last_error", "completed_at", "created_at", "updated_at"],
  higuchi_ai_usage: ["id", "organization_id", "request_key", "month", "model", "reserved_micros", "actual_micros", "status", "input_tokens", "output_tokens", "created_at"],
  higuchi_mail_receipts: ["id", "organization_id", "message_id", "to_email", "content_hash", "status", "provider_message_id", "provider_thread_id", "rfc_message_id", "accepted_at", "created_at"],
  higuchi_booking_settings: ["organization_id", "host_email", "settings", "updated_at"],
  higuchi_booking_invites: ["id", "organization_id", "project_id", "campaign_id", "lead_id", "token_hash", "expires_at", "revoked_at", "created_at"],
  higuchi_bookings: ["id", "organization_id", "project_id", "campaign_id", "lead_id", "invite_id", "starts_at", "ends_at", "guest_name", "guest_email", "status", "request_id", "manage_token_hash", "manage_expires_at", "version", "processed_requests", "created_at", "updated_at"],
};
const requiredTables = [...Object.keys(higuchiColumns), "crm_meetings", "jwks", "oauth_clients", "oauth_resources", "oauth_client_resources", "oauth_refresh_tokens", "oauth_access_tokens", "oauth_consents", "oauth_client_assertions"];
const requiredIndexes: [name: string, table: string, unique: boolean][] = [
  ["higuchi_jobs_idempotency_uq", "higuchi_jobs", true], ["higuchi_jobs_due_idx", "higuchi_jobs", false], ["higuchi_jobs_org_idx", "higuchi_jobs", false],
  ["higuchi_ai_usage_request_uq", "higuchi_ai_usage", true], ["higuchi_ai_usage_month_idx", "higuchi_ai_usage", false], ["higuchi_ai_usage_org_idx", "higuchi_ai_usage", false],
  ["higuchi_mail_receipt_message_uq", "higuchi_mail_receipts", true], ["higuchi_mail_receipt_date_idx", "higuchi_mail_receipts", false],
  ["higuchi_booking_host_email_uq", "higuchi_booking_settings", true], ["higuchi_booking_invite_token_uq", "higuchi_booking_invites", true], ["higuchi_booking_invite_lead_idx", "higuchi_booking_invites", false],
  ["higuchi_booking_manage_token_uq", "higuchi_bookings", true], ["higuchi_booking_request_uq", "higuchi_bookings", true], ["higuchi_booking_time_idx", "higuchi_bookings", false],
  ["higuchi_billing_customer_mapping_uq", "grid_providers", true],
];
const requiredColumns: Record<string, string[]> = {
  api_keys: ["scopes"], crm_records: ["booking_code", "booking_link_first_sent_at", "booking_link_sent_count"],
  crm_sequence_steps: ["timing", "channel"], crm_sequences: ["auto_send_reply", "then_sequence_id"], crm_settings: ["booking_url"],
};
for (const table of requiredTables) if (!new RegExp(`CREATE TABLE IF NOT EXISTS (?:public\\.)?${table}\\s*\\(`, "i").test(upgrade)) throw new Error(`Upgrade is missing table ${table}`);
for (const [table, columns] of Object.entries(higuchiColumns)) {
  const definition = upgrade.match(new RegExp(`CREATE TABLE IF NOT EXISTS (?:public\\.)?${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i"))?.[1];
  if (!definition) throw new Error(`Upgrade is missing the complete definition of ${table}`);
  for (const column of columns) if (!new RegExp(`(?:^|\\n)\\s*${column}\\s+`, "i").test(definition)) throw new Error(`Upgrade is missing column ${table}.${column}`);
}
for (const [name, table, unique] of requiredIndexes) if (!new RegExp(`CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${name} ON (?:public\\.)?${table}\\b`, "i").test(upgrade)) throw new Error(`Upgrade is missing guarded index ${name}`);
for (const [table, columns] of Object.entries(requiredColumns)) for (const column of columns) if (!new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column}\\s`, "i").test(upgrade)) throw new Error(`Upgrade is missing column ${table}.${column}`);
if (/\b(?:DROP\s+(?:TABLE|COLUMN|SCHEMA)|TRUNCATE|DELETE\s+FROM)\b/i.test(upgrade)) throw new Error("Upgrade must not remove stored data");

if (process.argv.includes("--check")) {
  console.log(`Static upgrade contract OK: ${requiredTables.length} guarded tables, ${Object.values(higuchiColumns).flat().length} higuchi columns, ${requiredIndexes.length} indexes and ${Object.values(requiredColumns).flat().length} guarded column additions; no data-removal statements. No database connection was opened.`);
} else {
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required");
  const parsed = new URL(url);
  if (parsed.hostname.includes("-pooler.") || parsed.searchParams.get("pgbouncer") === "true" || parsed.port === "6432") throw new Error("Schema migration requires a direct connection. Set DATABASE_URL_UNPOOLED to the direct PostgreSQL URL.");
  const client = new SQL(url, { tls: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: true }, max: 1 });
  try {
    await client.begin(async (tx) => {
      await tx.unsafe("SET LOCAL search_path = public; SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '2min';").simple();
      await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended('higuchi-schema-upgrade-v1', 0));").simple();
      await tx.unsafe(upgrade).simple();
    });
    console.log("higuchi-form workspace, durable jobs, usage, mail receipts, booking, billing mapping and upstream schemas are ready.");
  } finally { await client.close(); }
}
