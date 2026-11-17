import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";
import type { CreatePreviewInput, PreviewState, PreviewStatus } from "./types";

/** Anonymous staging is deliberately separate from all organization business data. */
export const higuchiPreviewSessions = pgTable("higuchi_preview_sessions", {
  id: uuid("id").defaultRandom().primaryKey(), tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at",{withTimezone:true}).notNull(), createdAt: timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex("higuchi_preview_session_token_uq").on(t.tokenHash),index("higuchi_preview_session_expiry_idx").on(t.expiresAt)]);
export const higuchiPreviewRuns = pgTable("higuchi_preview_runs", {
  id: uuid("id").defaultRandom().primaryKey(), sessionId: uuid("session_id").notNull().references(()=>higuchiPreviewSessions.id,{onDelete:"cascade"}),
  input: jsonb("input").notNull().$type<CreatePreviewInput>(), state: jsonb("state").notNull().$type<PreviewState>(),
  status: text("status").notNull().default("queued").$type<PreviewStatus>(), revision: integer("revision").notNull().default(0), generation: integer("generation").notNull().default(0),
  stageIndex: integer("stage_index").notNull().default(0), attempts: integer("attempts").notNull().default(0), retryCount: integer("retry_count").notNull().default(0),
  lockedBy: text("locked_by"), leaseUntil: timestamp("lease_until",{withTimezone:true}), runAfter: timestamp("run_after",{withTimezone:true}).notNull().defaultNow(),
  errorCode: text("error_code"), errorMessage: text("error_message"), errorRetryable: integer("error_retryable").notNull().default(0),
  claimedOrganizationId: uuid("claimed_organization_id").references(()=>organizations.id,{onDelete:"restrict"}), claimedProjectId: uuid("claimed_project_id"), claimedAt: timestamp("claimed_at",{withTimezone:true}),
  expiresAt: timestamp("expires_at",{withTimezone:true}).notNull(), createdAt: timestamp("created_at",{withTimezone:true}).notNull().defaultNow(), updatedAt: timestamp("updated_at",{withTimezone:true}).notNull().defaultNow(),
},t=>[index("higuchi_preview_run_session_idx").on(t.sessionId),index("higuchi_preview_run_due_idx").on(t.status,t.runAfter),index("higuchi_preview_run_expiry_idx").on(t.expiresAt)]);
export const higuchiPreviewDailyLimits = pgTable("higuchi_preview_daily_limits", {
  ipDayHash:text("ip_day_hash").primaryKey(), day:text("day").notNull(), runs:integer("runs").notNull().default(0), createdAt:timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
},t=>[index("higuchi_preview_limit_day_idx").on(t.day)]);
/** Two global slots cap provider concurrency across processes, not just within one Cron. */
export const higuchiPreviewWorkerSlots = pgTable("higuchi_preview_worker_slots", {
  slot:integer("slot").primaryKey(), owner:text("owner"), leaseUntil:timestamp("lease_until",{withTimezone:true}),
});
export const higuchiPreviewAiUsage = pgTable("higuchi_preview_ai_usage", {
  id:uuid("id").defaultRandom().primaryKey(), runId:uuid("run_id").notNull().references(()=>higuchiPreviewRuns.id,{onDelete:"restrict"}),
  requestKey:text("request_key").notNull(), month:text("month").notNull(), model:text("model").notNull(),
  reservedMicros:integer("reserved_micros").notNull(), actualMicros:integer("actual_micros"), inputTokens:integer("input_tokens"), outputTokens:integer("output_tokens"), searchCalls:integer("search_calls").notNull().default(0), status:text("status").notNull().default("reserved"),
  createdAt:timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex("higuchi_preview_ai_request_uq").on(t.requestKey),index("higuchi_preview_ai_month_idx").on(t.month),index("higuchi_preview_ai_run_idx").on(t.runId)]);
