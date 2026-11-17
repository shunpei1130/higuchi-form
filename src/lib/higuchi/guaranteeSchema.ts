import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";
/** A refund request belongs to one billing organization; payment identities remain globally unique. */
export const higuchiRefundRequests=pgTable("higuchi_refund_requests",{
  id:uuid("id").defaultRandom().primaryKey(),organizationId:uuid("organization_id").notNull().references(()=>organizations.id,{onDelete:"cascade"}),
  sessionId:text("session_id").notNull(),paymentIntentId:text("payment_intent_id"),chargeId:text("charge_id"),
  currency:text("currency").notNull(),amountMinor:integer("amount_minor").notNull(),priceVersion:text("price_version").notNull(),
  purchasedAt:timestamp("purchased_at",{withTimezone:true}).notNull(),qualifiedAt:timestamp("qualified_at",{withTimezone:true}).notNull(),
  sentCount:integer("sent_count").notNull(),positiveCount:integer("positive_count").notNull(),
  status:text("status").notNull().default("requested"),requestedBy:text("requested_by").notNull(),
  note:text("note").notNull().default(""),reviewedBy:text("reviewed_by"),stripeRefundId:text("stripe_refund_id"),
  createdAt:timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp("updated_at",{withTimezone:true}).notNull().defaultNow(),
},table=>[uniqueIndex("higuchi_refund_request_payment_uq").on(table.sessionId),uniqueIndex("higuchi_refund_stripe_uq").on(table.stripeRefundId),index("higuchi_refund_request_org_idx").on(table.organizationId),index("higuchi_refund_request_status_idx").on(table.status,table.createdAt)]);
