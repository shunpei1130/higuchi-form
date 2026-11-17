import { after } from "next/server";
import { assertPreviewEnabled, assertPreviewOrigin, previewError, previewJson, readPreviewBody } from "@/lib/higuchi/preview/http";
import { parseCreatePreview } from "@/lib/higuchi/preview/rules";
import { createPreview } from "@/lib/higuchi/preview/store";
import { runPreviewWorker } from "@/lib/higuchi/preview/worker";
export const runtime="nodejs";
export const maxDuration=120;
export async function POST(request:Request){try{assertPreviewOrigin(request);assertPreviewEnabled();const result=await createPreview(request,parseCreatePreview(await readPreviewBody(request)));after(async()=>{await runPreviewWorker({preferredRunId:result.snapshot.id});});return previewJson(result.snapshot,200,result.cookie);}catch(error){return previewError(error);}}
