import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

// Credentials come from DATABASE_URL — never hardcode them here. The
// scripts/ migrations read the same variable, so the app and the schema
// tooling always point at the same database.
//
// The client is created on first use, not when this module loads: `next
// build` loads every route to collect page data, and a build must not need
// database credentials (the Docker build context carries no .env). A
// missing DATABASE_URL still fails loudly — at the first query.

function createDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set — copy .env.example to .env.local and fill it in");
  }

  // Serverless instances multiply pools, so each Vercel instance uses at most
  // two connections. Long-running local/container processes retain their limit.
  const serverless = Boolean(process.env.VERCEL);
  const requestedPoolSize = Number(process.env.DB_POOL_MAX ?? (serverless ? 2 : 8));
  if (!Number.isInteger(requestedPoolSize) || requestedPoolSize < 1) throw new Error("DB_POOL_MAX must be a positive integer");
  const url = new URL(connectionString);
  const pooled = url.hostname.includes("-pooler.") || url.searchParams.get("pgbouncer") === "true" || url.port === "6432";
  const client = postgres(connectionString, {
    ssl: process.env.DATABASE_SSL === "disable" ? false : "require",
    max: serverless ? Math.min(requestedPoolSize, 2) : requestedPoolSize,
    prepare: !pooled,
    idle_timeout: 20,
  });
  return drizzle(client, { schema });
}

type Db = ReturnType<typeof createDb>;
let instance: Db | undefined;

/** The one Drizzle instance, created on first property access. */
export const db: Db = new Proxy({} as Db, {
  get(_, prop) {
    instance ??= createDb();
    const value = Reflect.get(instance, prop, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
