import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { higuchiJobs } from "./schema";

export type JobsTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type JobsExecutor = typeof db | JobsTransaction;
export type DurableJob = typeof higuchiJobs.$inferSelect;
export type NewJob = { organizationId?: string | null; kind: string; entityId?: string; idempotencyKey: string; payload?: Record<string, unknown>; runAt?: Date | string; maxAttempts?: number; coalesce?:boolean };

export async function enqueueJob(input: NewJob, executor: JobsExecutor = db): Promise<string> {
  if (!input.organizationId && input.kind !== "notification") throw new Error("組織を指定してください。");
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(input.kind) || !input.idempotencyKey || input.idempotencyKey.length > 240) throw new Error("ジョブの識別子が正しくありません。");
  const runAt=input.runAt?new Date(input.runAt):new Date(),attemptLimit=input.maxAttempts??8;
  if(!Number.isFinite(runAt.getTime())||!Number.isSafeInteger(attemptLimit)||attemptLimit<1||attemptLimit>20)throw new Error("ジョブの実行条件が正しくありません。");
  const key = `${input.organizationId ?? "platform"}:${input.kind}:${input.idempotencyKey}`;
  const [created] = await executor.insert(higuchiJobs).values({organizationId:input.organizationId ?? null,kind:input.kind,entityId:input.entityId,idempotencyKey:key,payload:input.payload ?? {},runAfter:runAt,maxAttempts:attemptLimit}).onConflictDoNothing({target:higuchiJobs.idempotencyKey}).returning({id:higuchiJobs.id});
  if (created) return created.id;
  const [existing] = await executor.select({id:higuchiJobs.id}).from(higuchiJobs).where(eq(higuchiJobs.idempotencyKey,key)).limit(1);
  if (!existing) throw new Error("ジョブを保存できませんでした。");
  // One durable row per recurring work item. Never replace a running/pending
  // claim, and never reset the attempt counter used as its fencing version.
  if(input.coalesce)await executor.update(higuchiJobs).set({status:"pending",runAfter:runAt,maxAttempts:sql`${higuchiJobs.attempts}+${attemptLimit}`,payload:input.payload??{},completedAt:null,lastError:null,lockedBy:null,leaseUntil:null,updatedAt:new Date()}).where(and(eq(higuchiJobs.id,existing.id),sql`${higuchiJobs.status} in ('completed','failed')`,sql`${higuchiJobs.updatedAt} < now()-interval '30 seconds'`));
  return existing.id;
}

export async function claimJob(worker: string,filter:{organizationId?:string;kind?:string}={}): Promise<DurableJob | null> {
  if(!worker||worker.length>150)throw new Error("ジョブの実行者が正しくありません。");
  const owner=`${worker}/${randomUUID()}`,orgFilter=filter.organizationId?sql`AND organization_id=${filter.organizationId}::uuid`:sql``,kindFilter=filter.kind?sql`AND kind=${filter.kind}`:sql``;
  return db.transaction(async tx => {
    await tx.execute(sql`UPDATE higuchi_jobs SET status='failed',locked_by=null,lease_until=null,completed_at=now(),updated_at=now(),last_error='実行が中断され、再試行の上限に達しました。' WHERE status='running' AND lease_until<now() AND attempts>=max_attempts ${orgFilter} ${kindFilter}`);
    const rows = await tx.execute(sql`WITH due AS (
      SELECT id FROM higuchi_jobs
      WHERE ((status='pending' AND run_after <= now()) OR (status='running' AND lease_until < now())) AND attempts < max_attempts ${orgFilter} ${kindFilter}
      ORDER BY CASE kind WHEN 'notification' THEN 0 ELSE 1 END, run_after, created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE higuchi_jobs j SET status='running', locked_by=${owner}, lease_until=now()+interval '180 seconds', attempts=j.attempts+1, updated_at=now()
    FROM due WHERE j.id=due.id RETURNING j.id`);
    const id = (rows as unknown as Array<{id:string}>)[0]?.id;
    if (!id) return null;
    const [job] = await tx.select().from(higuchiJobs).where(eq(higuchiJobs.id,id));
    return job ?? null;
  });
}

export async function completeJob(job: DurableJob, worker: string): Promise<boolean> {
  if(!job.lockedBy?.startsWith(`${worker}/`))return false;
  const changed=await db.update(higuchiJobs).set({status:"completed",completedAt:new Date(),lockedBy:null,leaseUntil:null,lastError:null,updatedAt:new Date()}).where(and(eq(higuchiJobs.id,job.id),eq(higuchiJobs.status,"running"),eq(higuchiJobs.lockedBy,job.lockedBy),eq(higuchiJobs.attempts,job.attempts))).returning({id:higuchiJobs.id});
  return changed.length===1;
}
export class PermanentJobError extends Error {}
export async function failJob(job: DurableJob, worker: string, error: unknown): Promise<boolean> {
  if(!job.lockedBy?.startsWith(`${worker}/`))return false;
  const terminal = error instanceof PermanentJobError || job.attempts >= job.maxAttempts;
  const message = error instanceof Error ? error.message : "処理に失敗しました。";
  // Store a short explanation, never provider request/response objects or credentials.
  const safe = message.replace(/whsec_[A-Za-z0-9_+/=-]{8,}|(?:sk[-_]|re_|rk_|ya29\.)[A-Za-z0-9_.-]{8,}/g,"[redacted]").replace(/Bearer\s+[^\s]+/gi,"Bearer [redacted]").replace(/1\/\/[A-Za-z0-9_-]{20,}/g,"[redacted]").slice(0,500);
  const changed=await db.update(higuchiJobs).set({status:terminal?"failed":"pending",completedAt:terminal?new Date():null,runAfter:new Date(Date.now()+Math.min(3600000,30000*2**Math.min(job.attempts,7))),lastError:safe,lockedBy:null,leaseUntil:null,updatedAt:new Date()}).where(and(eq(higuchiJobs.id,job.id),eq(higuchiJobs.status,"running"),eq(higuchiJobs.lockedBy,job.lockedBy),eq(higuchiJobs.attempts,job.attempts))).returning({id:higuchiJobs.id});
  return changed.length===1;
}
