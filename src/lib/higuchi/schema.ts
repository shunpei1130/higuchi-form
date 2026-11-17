import { pgTable, uuid, jsonb, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";
import type { WorkspaceState } from "./state";

/** A single locked aggregate per tenant keeps balances, reservations and transitions atomic. */
export const higuchiWorkspaces = pgTable("higuchi_workspaces", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  state: jsonb("state").notNull().$type<WorkspaceState>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
