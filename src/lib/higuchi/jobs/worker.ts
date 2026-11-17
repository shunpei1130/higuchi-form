import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { higuchiWorkspaces } from "../schema";
import { runInOrganization } from "@/lib/tenancy/scope";
import { claimJob, completeJob, enqueueJob, failJob } from "./store";

export async function runHiguchiJobs():Promise<{processed:number;failed:number}>{
  if(process.env.VERCEL_ENV!=="production"||process.env.HIGUCHI_MODE!=="live")throw new Error("本番環境だけで実行できます。");
  const started=Date.now(),worker=randomUUID();
  async function seedDueWork(){
    // Fetch metadata only, and rotate organizations whose plans were seeded
    // longest ago. Never transfer every tenant's full JSON state into a Cron.
    const organizations=await db.select({id:higuchiWorkspaces.organizationId,email:sql<boolean>`coalesce((${higuchiWorkspaces.state}->'integrations'->'email'->>'connected')::boolean,false)`,hasThread:sql<boolean>`exists(select 1 from jsonb_array_elements(${higuchiWorkspaces.state}->'conversations') t where t->>'providerThreadId' is not null)`}).from(higuchiWorkspaces).orderBy(sql`coalesce((select max(j.updated_at) from higuchi_jobs j where j.organization_id=${higuchiWorkspaces.organizationId} and j.kind='workspace.plan'),'-infinity'::timestamptz)`).limit(10);
    for(const {id,email,hasThread}of organizations){
      if(Date.now()-started>8000)break;
      await enqueueJob({organizationId:id,kind:"workspace.plan",idempotencyKey:"periodic",coalesce:true});
      if(email&&hasThread)await enqueueJob({organizationId:id,kind:"inbox.sync",idempotencyKey:"periodic",coalesce:true});
    }
  }
  let processed=0,failed=0,claimed=0;
  async function consume(){
    // Every provider operation is bounded to <=65s. Stop admitting work after 30s.
    while(Date.now()-started<30000&&claimed<8){
      claimed++;const job=await claimJob(worker);if(!job)return;
      try{
        if(job.kind==="notification"){const {processNotificationJob}=await import("../notifications");await processNotificationJob(job);}
        else{const {handleWorkspaceJob}=await import("./handlers");await runInOrganization(job.organizationId!,()=>handleWorkspaceJob(job));}
        if(await completeJob(job,worker))processed++;
      }catch(error){if(await failJob(job,worker,error))failed++;}
    }
  }
  // OTP notifications already in the queue start immediately, independently
  // of planner queries and their network latency.
  await Promise.all([seedDueWork(),consume(),consume()]);return {processed,failed};
}
