import { assertSameOrigin } from "@/lib/higuchi/service";
import { productErrorResponse } from "@/lib/higuchi/http";
import { ProductError } from "@/lib/higuchi/state";
import { startClaimedPreview } from "@/lib/higuchi/previewClaim";
import { readPreviewBody } from "@/lib/higuchi/preview/http";
export const runtime="nodejs";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{assertSameOrigin(request);const raw=await readPreviewBody(request);if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new ProductError("営業の開始を確認してください。");const body=raw as Record<string,unknown>;if(typeof body.requestId!=="string"||body.requestId.length<1||body.requestId.length>160||body.consent!==true)throw new ProductError("宛先・文面・料金を確認し、営業の開始を承認してください。");return Response.json(await startClaimedPreview(request,(await params).id,body.requestId),{headers:{"Cache-Control":"no-store"}});}catch(error){return productErrorResponse(error);}}
