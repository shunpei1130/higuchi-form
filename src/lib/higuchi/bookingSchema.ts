import { pgTable, uuid, text, jsonb, timestamp, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";
import type { BookingSettings } from "./booking/types";

export const higuchiBookingSettings = pgTable("higuchi_booking_settings", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  hostEmail: text("host_email").notNull(),
  settings: jsonb("settings").notNull().$type<BookingSettings>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("higuchi_booking_host_email_uq").on(table.hostEmail)]);

export const higuchiBookingInvites = pgTable("higuchi_booking_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull(), campaignId: uuid("campaign_id").notNull(), leadId: uuid("lead_id").notNull(),
  tokenHash: text("token_hash").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("higuchi_booking_invite_token_uq").on(table.tokenHash), index("higuchi_booking_invite_lead_idx").on(table.organizationId, table.leadId, table.campaignId)]);

export const higuchiBookings = pgTable("higuchi_bookings", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull(), campaignId: uuid("campaign_id").notNull(), leadId: uuid("lead_id").notNull(),
  inviteId: uuid("invite_id").notNull().references(() => higuchiBookingInvites.id, { onDelete: "restrict" }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(), endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  guestName: text("guest_name").notNull(), guestEmail: text("guest_email").notNull(),
  status: text("status").notNull().$type<"booked" | "cancelled">(),
  requestId: text("request_id").notNull(), manageTokenHash: text("manage_token_hash").notNull(),
  manageExpiresAt: timestamp("manage_expires_at", { withTimezone: true }).notNull(), version: integer("version").notNull().default(1),
  processedRequests: jsonb("processed_requests").notNull().$type<string[]>().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("higuchi_booking_manage_token_uq").on(table.manageTokenHash), uniqueIndex("higuchi_booking_request_uq").on(table.organizationId, table.requestId), index("higuchi_booking_time_idx").on(table.organizationId, table.startsAt)]);
