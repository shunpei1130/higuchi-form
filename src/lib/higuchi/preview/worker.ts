import "server-only";
import { ProductError } from "../state";
import { claimPreviewStage, settlePreviewStage } from "./store";
import { executePreviewStage } from "./research";
import { dispatchPreviewContinuation } from "./dispatch";
import { assertPreviewFixtureConfiguration, previewFixtureEnabled } from "./fixture";
/** Invoked immediately by Next after(), and periodically by the authenticated Cron fallback. */
export async function runPreviewWorker(input:{preferredRunId?:string;maxStages?:number}={}):Promise<{processed:number;failed:number}> {
  assertPreviewFixtureConfiguration();
  if(process.env.HIGUCHI_PUBLIC_PREVIEW==="false"||process.env.HIGUCHI_MODE!=="live"||(process.env.VERCEL_ENV&&process.env.VERCEL_ENV!=="production"&&!previewFixtureEnabled()))return {processed:0,failed:0};
  const started=Date.now(),limit=Math.min(6,Math.max(1,input.maxStages??2));let processed=0,failed=0;
  for(let i=0;i<limit&&Date.now()-started<25000;i++){
    const claim=await claimPreviewStage(input.preferredRunId);if(!claim)break;
    try{const state=await executePreviewStage(claim.run);if(await settlePreviewStage(claim,state)){processed++;if(claim.run.stageIndex<5)await dispatchPreviewContinuation(claim.run.id);}}
    catch(error){const code=error instanceof ProductError?error.code:"PREVIEW_RESEARCH_FAILED",safe=error instanceof ProductError?error.message:"公開情報の調査を完了できませんでした。時間をおいて再試行してください。",retryable=!["AI_UNCONFIGURED","PREVIEW_DISABLED","MODEL_UNPRICED","AI_BUDGET","AI_BUDGET_EXCEEDED","PREVIEW_RUN_BUDGET","PREVIEW_SEARCH_LIMIT"].includes(code);if(await settlePreviewStage(claim,claim.run.state,{code,message:safe,retryable}))failed++;}
  }
  return {processed,failed};
}
