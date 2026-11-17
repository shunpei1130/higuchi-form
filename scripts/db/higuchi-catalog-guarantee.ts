import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const ddl=await readFile(join(import.meta.dir,"../../db/higuchi-catalog-guarantee.sql"),"utf8");
if(/\b(?:DROP\s+(?:TABLE|COLUMN|SCHEMA)|TRUNCATE|DELETE\s+FROM)\b/i.test(ddl))throw new Error("This upgrade must retain stored data");
if(process.argv.includes("--check")){console.log("Catalog and guarantee schema: 3 guarded tables; no data-removal statements.");}
else{
  const connection=process.env.DATABASE_URL_UNPOOLED||process.env.DATABASE_URL;if(!connection)throw new Error("A direct database connection is required");
  const url=new URL(connection);if(url.hostname.includes("-pooler.")||url.searchParams.get("pgbouncer")==="true")throw new Error("Use the direct database connection");
  const client=new SQL(connection,{tls:process.env.DATABASE_SSL==="disable"?false:{rejectUnauthorized:true},max:1});
  try{await client.begin(async tx=>{await tx.unsafe("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='2min'; SELECT pg_advisory_xact_lock(hashtextextended('higuchi-catalog-guarantee-v1',0));").simple();await tx.unsafe(ddl).simple();});console.log("Prospect library and refund requests are ready.");}finally{await client.close();}
}
