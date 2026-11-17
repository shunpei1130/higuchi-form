import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** Platform-curated prospect library. Private CRM imports are never searched anonymously. */
export const higuchiProspectDatasets = pgTable("higuchi_prospect_datasets", {
  id: uuid("id").defaultRandom().primaryKey(), name: text("name").notNull(),
  source: text("source").notNull(), published: boolean("published").notNull().default(false),
  rowCount: integer("row_count").notNull().default(0), revision: integer("revision").notNull().default(1),
  createdBy: text("created_by").notNull(), createdAt: timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
}, table => [index("higuchi_prospect_dataset_public_idx").on(table.published)]);

export const higuchiProspectRecords = pgTable("higuchi_prospect_records", {
  id: uuid("id").defaultRandom().primaryKey(), datasetId: uuid("dataset_id").notNull().references(()=>higuchiProspectDatasets.id,{onDelete:"cascade"}),
  externalKey: text("external_key").notNull(), companyName: text("company_name").notNull(), domain: text("domain").notNull().default(""),
  description: text("description").notNull().default(""), location: text("location").notNull().default(""),
  employeeCount: integer("employee_count"), monthlyTraffic: integer("monthly_traffic"), trafficGrowth: integer("traffic_growth"),
  name: text("name").notNull().default(""), role: text("role").notNull().default(""), email: text("email").notNull().default(""),
  verification: text("verification").notNull().default("unknown"), sourceUrl: text("source_url").notNull().default(""),
  extra: jsonb("extra").notNull().default({}).$type<Record<string,string>>(),
}, table=>[uniqueIndex("higuchi_prospect_record_key_uq").on(table.datasetId,table.externalKey),index("higuchi_prospect_record_domain_idx").on(table.datasetId,table.domain),index("higuchi_prospect_record_location_idx").on(table.location)]);
