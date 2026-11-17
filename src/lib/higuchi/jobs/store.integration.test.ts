import { expect,test } from "bun:test";
import { randomUUID } from "node:crypto";
const testDatabase=process.env.HIGUCHI_JOBS_TEST_DATABASE_URL;
if(testDatabase&&process.env.DATABASE_URL!==testDatabase)throw new Error("キュー試験は専用TEST DBに限定してください。");
test.skipIf(!testDatabase)("実DB: キュー重複排除・並行claim・期限回収・所有者fence・rollback",async()=>{
  const [{db},{organizations},{higuchiJobs},queue,{and,eq,sql}]=await Promise.all([import("@/lib/db"),import("@/lib/auth/schema"),import("./schema"),import("./store"),import("drizzle-orm")]);
  const orgA=randomUUID(),orgB=randomUUID();
  try{
    await db.insert(organizations).values([{id:orgA,name:"キュー試験A",slug:`queue-test-${orgA}`},{id:orgB,name:"キュー試験B",slug:`queue-test-${orgB}`}]);
    const repeated=await Promise.all(Array.from({length:6},()=>queue.enqueueJob({organizationId:orgA,kind:"fixture.dedup",idempotencyKey:"same"})));
    expect(new Set(repeated).size).toBe(1);
    await expect(db.transaction(async tx=>{await queue.enqueueJob({organizationId:orgA,kind:"fixture.rollback",idempotencyKey:"rollback"},tx);throw new Error("expected-fixture-rollback");})).rejects.toThrow("expected-fixture-rollback");
    expect(await db.select().from(higuchiJobs).where(and(eq(higuchiJobs.organizationId,orgA),eq(higuchiJobs.kind,"fixture.rollback")))).toHaveLength(0);
    await Promise.all(Array.from({length:6},(_,i)=>queue.enqueueJob({organizationId:orgA,kind:"fixture.claim",idempotencyKey:String(i)})));
    const foreignId=await queue.enqueueJob({organizationId:orgB,kind:"fixture.claim",idempotencyKey:"foreign"});
    const claimed=await Promise.all(Array.from({length:6},(_,i)=>queue.claimJob(`worker-${i}`,{organizationId:orgA,kind:"fixture.claim"})));
    expect(claimed.every(Boolean)).toBe(true);expect(new Set(claimed.map(job=>job?.id)).size).toBe(6);expect(claimed.every(job=>job?.organizationId===orgA)).toBe(true);
    for(const [i,job]of claimed.entries())expect(await queue.completeJob(job!,`worker-${i}`)).toBe(true);
    expect(await queue.claimJob("none",{organizationId:orgA,kind:"fixture.claim"})).toBeNull();
    expect((await db.select().from(higuchiJobs).where(eq(higuchiJobs.id,foreignId)))[0].status).toBe("pending");
    const leasedId=await queue.enqueueJob({organizationId:orgA,kind:"fixture.lease",idempotencyKey:"lease",maxAttempts:3});
    const first=await queue.claimJob("same-worker",{organizationId:orgA,kind:"fixture.lease"});expect(first?.id).toBe(leasedId);
    await db.update(higuchiJobs).set({leaseUntil:new Date(Date.now()-60_000)}).where(eq(higuchiJobs.id,leasedId));
    const second=await queue.claimJob("same-worker",{organizationId:orgA,kind:"fixture.lease"});expect(second?.attempts).toBe(2);expect(second?.lockedBy).not.toBe(first?.lockedBy);
    expect(await queue.completeJob(first!,"same-worker")).toBe(false);expect(await queue.failJob(first!,"same-worker",new Error("stale"))).toBe(false);
    expect(await queue.completeJob(second!,"same-worker")).toBe(true);
    const exhaustedId=await queue.enqueueJob({organizationId:orgA,kind:"fixture.exhausted",idempotencyKey:"last",maxAttempts:1});
    const last=await queue.claimJob("last-worker",{organizationId:orgA,kind:"fixture.exhausted"});
    await db.update(higuchiJobs).set({leaseUntil:new Date(Date.now()-60_000)}).where(eq(higuchiJobs.id,exhaustedId));
    expect(await queue.claimJob("recovery",{organizationId:orgA,kind:"fixture.exhausted"})).toBeNull();
    expect((await db.select().from(higuchiJobs).where(eq(higuchiJobs.id,exhaustedId)))[0].status).toBe("failed");expect(await queue.completeJob(last!,"last-worker")).toBe(false);
    const periodicId=await queue.enqueueJob({organizationId:orgA,kind:"fixture.periodic",idempotencyKey:"periodic",coalesce:true,payload:{original:true}});
    const periodic=await queue.claimJob("periodic",{organizationId:orgA,kind:"fixture.periodic"});
    await queue.enqueueJob({organizationId:orgA,kind:"fixture.periodic",idempotencyKey:"periodic",coalesce:true,payload:{replaced:true}});
    const running=(await db.select().from(higuchiJobs).where(eq(higuchiJobs.id,periodicId)))[0];expect(running.status).toBe("running");expect(running.payload.original).toBe(true);
    expect(await queue.completeJob(periodic!,"periodic")).toBe(true);
    await db.update(higuchiJobs).set({updatedAt:new Date(Date.now()-60_000)}).where(eq(higuchiJobs.id,periodicId));
    expect(await queue.enqueueJob({organizationId:orgA,kind:"fixture.periodic",idempotencyKey:"periodic",coalesce:true})).toBe(periodicId);
    const recurring=await queue.claimJob("periodic",{organizationId:orgA,kind:"fixture.periodic"});expect(recurring?.attempts).toBe(2);expect(await queue.completeJob(periodic!,"periodic")).toBe(false);expect(await queue.completeJob(recurring!,"periodic")).toBe(true);
    const errorId=await queue.enqueueJob({organizationId:orgA,kind:"fixture.error",idempotencyKey:"error"});const errorJob=await queue.claimJob("error",{organizationId:orgA,kind:"fixture.error"});
    await queue.failJob(errorJob!,"error",new Error("sk_live_abcdefghijklmnop whsec_abcdefghijklmnop Bearer secret-string"));
    const error=(await db.select().from(higuchiJobs).where(eq(higuchiJobs.id,errorId)))[0];expect(error.lastError).not.toContain("abcdefghijklmnop");expect(error.lastError).not.toContain("secret-string");
  }finally{
    await db.delete(organizations).where(sql`${organizations.id} in (${orgA}::uuid,${orgB}::uuid)`);
  }
},60_000);
