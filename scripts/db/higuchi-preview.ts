import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const ddl=await readFile(join(import.meta.dir,"..","..","db","higuchi-preview.sql"),"utf8");
const tables=["sessions","runs","daily_limits","worker_slots","ai_usage"].map(n=>`higuchi_preview_${n}`);
for(const table of tables)if(!new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\s*\\(`).test(ddl))throw new Error(`Missing table ${table}`);
if(/\b(DROP|TRUNCATE|DELETE)\b/i.test(ddl.replace(/ON DELETE (?:CASCADE|RESTRICT)/gi,"")))throw new Error("Preview migration must be additive");
if(process.argv.includes("--check"))console.log(`Preview schema contract OK: ${tables.length} guarded tables. No database connection opened.`);
else {
  const url=process.env.DATABASE_URL_UNPOOLED||process.env.DATABASE_URL;if(!url)throw new Error("A direct DATABASE_URL_UNPOOLED is required");
  const parsed=new URL(url);if(parsed.hostname.includes("-pooler.")||parsed.searchParams.get("pgbouncer")==="true"||parsed.port==="6432")throw new Error("Use a direct database connection for schema changes");
  const client=new SQL(url,{tls:process.env.DATABASE_SSL==="disable"?false:{rejectUnauthorized:true},max:1});
  try{await client.begin(async tx=>{await tx.unsafe("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='2min'; SELECT pg_advisory_xact_lock(hashtextextended('higuchi-preview-schema-v1',0));").simple();await tx.unsafe(ddl).simple();});console.log("Anonymous preview schema ready.");}finally{await client.close();}
}
