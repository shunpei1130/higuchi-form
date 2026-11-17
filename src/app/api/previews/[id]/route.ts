import { after } from "next/server";
import { assertPreviewEnabled, assertPreviewOrigin, previewError, previewJson, readPreviewBody } from "@/lib/higuchi/preview/http";
import { parsePatchPreview } from "@/lib/higuchi/preview/rules";
import { getPreview, patchPreview } from "@/lib/higuchi/preview/store";
import { runPreviewWorker } from "@/lib/higuchi/preview/worker";
export const runtime="nodejs";
export const maxDuration=120;
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,context:Context){try{assertPreviewEnabled();const snapshot=await getPreview(request,(await context.params).id);if(snapshot.status==="queued"||snapshot.status==="running")after(async()=>{await runPreviewWorker({preferredRunId:snapshot.id});});return previewJson(snapshot);}catch(error){return previewError(error);}}
export async function PATCH(request:Request,context:Context){try{assertPreviewOrigin(request);assertPreviewEnabled();const snapshot=await patchPreview(request,(await context.params).id,parsePatchPreview(await readPreviewBody(request)));if(snapshot.status==="queued")after(async()=>{await runPreviewWorker({preferredRunId:snapshot.id});});return previewJson(snapshot);}catch(error){return previewError(error);}}
