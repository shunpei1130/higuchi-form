import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";

/** Private platform queue: tenant work has an org, pre-login authentication mail does not. */
export const higuchiJobs = pgTable("higuchi_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), entityId: text("entity_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  payload: jsonb("payload").notNull().default({}).$type<Record<string, unknown>>(),
  status: text("status").notNull().default("pending"),
  runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
  lockedBy: text("locked_by"), leaseUntil: timestamp("lease_until", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0), maxAttempts: integer("max_attempts").notNull().default(8),
  lastError: text("last_error"), completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("higuchi_jobs_idempotency_uq").on(table.idempotencyKey), index("higuchi_jobs_due_idx").on(table.status, table.runAfter), index("higuchi_jobs_org_idx").on(table.organizationId)]);

export const higuchiAiUsage = pgTable("higuchi_ai_usage", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  requestKey: text("request_key").notNull(), month: text("month").notNull(), model: text("model").notNull(),
  reservedMicros: integer("reserved_micros").notNull(), actualMicros: integer("actual_micros"),
  status: text("status").notNull().default("reserved"), inputTokens: integer("input_tokens"), outputTokens: integer("output_tokens"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("higuchi_ai_usage_request_uq").on(table.requestKey), index("higuchi_ai_usage_month_idx").on(table.month),index("higuchi_ai_usage_org_idx").on(table.organizationId)]);

/** Provider receipt is committed before charging; an uncertain send is never reissued automatically. */
export const higuchiMailReceipts = pgTable("higuchi_mail_receipts", {
  id:uuid("id").defaultRandom().primaryKey(), organizationId:uuid("organization_id").notNull().references(()=>organizations.id,{onDelete:"cascade"}),
  messageId:text("message_id").notNull(), toEmail:text("to_email").notNull(), contentHash:text("content_hash").notNull(),
  status:text("status").notNull().default("pending"), providerMessageId:text("provider_message_id"), providerThreadId:text("provider_thread_id"), rfcMessageId:text("rfc_message_id"),
  acceptedAt:timestamp("accepted_at",{withTimezone:true}), createdAt:timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
},table=>[uniqueIndex("higuchi_mail_receipt_message_uq").on(table.organizationId,table.messageId),index("higuchi_mail_receipt_date_idx").on(table.organizationId,table.createdAt)]);
