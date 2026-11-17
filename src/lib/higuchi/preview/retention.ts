import "server-only";
import { and, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { higuchiPreviewRuns, higuchiPreviewSessions } from "./schema";
import { expiredPreviewPatch, PREVIEW_SCRUBBED_CODE } from "./retentionPolicy";

/** Bounded, restartable PII cleanup. Never deletes a run/session or its monthly cost ledger. */
export async function scrubExpiredPreviews(input:{limit?:number;now?:Date}={}):Promise<{runs:number;sessions:number}>{
  const now=input.now??new Date(),limit=Math.max(1,Math.min(250,Math.floor(input.limit??100)));
  if(!Number.isFinite(now.getTime())||!Number.isFinite(limit))throw new Error("Invalid preview retention parameters");
  return db.transaction(async tx=>{
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
    const runs=await tx.select({id:higuchiPreviewRuns.id}).from(higuchiPreviewRuns)
      .where(and(lte(higuchiPreviewRuns.expiresAt,now),sql`${higuchiPreviewRuns.errorCode} IS DISTINCT FROM ${PREVIEW_SCRUBBED_CODE}`))
      .orderBy(higuchiPreviewRuns.expiresAt).for("update",{skipLocked:true}).limit(limit);
    if(runs.length)await tx.update(higuchiPreviewRuns).set({...expiredPreviewPatch({status:"failed",revision:0,generation:0},now),status:sql`CASE WHEN ${higuchiPreviewRuns.status}='claimed' THEN 'claimed' ELSE 'failed' END`,revision:sql`${higuchiPreviewRuns.revision}+1`,generation:sql`${higuchiPreviewRuns.generation}+1`}).where(and(inArray(higuchiPreviewRuns.id,runs.map(r=>r.id)),lte(higuchiPreviewRuns.expiresAt,now)));
    const sessions=await tx.select({id:higuchiPreviewSessions.id}).from(higuchiPreviewSessions)
      .where(and(lte(higuchiPreviewSessions.expiresAt,now),sql`${higuchiPreviewSessions.tokenHash} NOT LIKE 'expired:%'`))
      .orderBy(higuchiPreviewSessions.expiresAt).for("update",{skipLocked:true}).limit(limit);
    if(sessions.length)await tx.update(higuchiPreviewSessions).set({tokenHash:sql`'expired:' || ${higuchiPreviewSessions.id}::text`}).where(and(inArray(higuchiPreviewSessions.id,sessions.map(s=>s.id)),lte(higuchiPreviewSessions.expiresAt,now)));
    // An expired run may still have a bounded provider call in flight. Its global worker slot
    // stays leased until that call finishes or expires, preserving the two-provider-call cap.
    return {runs:runs.length,sessions:sessions.length};
  });
}
