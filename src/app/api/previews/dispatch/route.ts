import { after } from "next/server";
import { assertPreviewDispatcher } from "@/lib/higuchi/preview/dispatch";
import { assertPreviewEnabled, previewError, previewJson, readPreviewBody } from "@/lib/higuchi/preview/http";
import { runPreviewWorker } from "@/lib/higuchi/preview/worker";
import { ProductError } from "@/lib/higuchi/state";
export const runtime="nodejs";
export const maxDuration=120;
export async function POST(request:Request){try{assertPreviewDispatcher(request);assertPreviewEnabled();const body=await readPreviewBody(request) as {runId?:unknown};if(!body||typeof body.runId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.runId))throw new ProductError("調査IDを確認してください。");const runId=body.runId;after(async()=>{await runPreviewWorker({preferredRunId:runId,maxStages:1});});return previewJson({accepted:true},202);}catch(error){return previewError(error);}}
