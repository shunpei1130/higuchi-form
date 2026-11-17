import { assertSameOrigin } from "@/lib/higuchi/service";
import { productErrorResponse } from "@/lib/higuchi/http";
import { ProductError } from "@/lib/higuchi/state";
import { recordPreviewConsent } from "@/lib/higuchi/previewClaim";
import { readPreviewBody } from "@/lib/higuchi/preview/http";
export const runtime="nodejs";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{assertSameOrigin(request);const body=await readPreviewBody(request);if(!body||typeof body!=="object"||Array.isArray(body)||((body as Record<string,unknown>).consent!==true||typeof (body as Record<string,unknown>).sessionId!=="string"))throw new ProductError("宛先・文面・料金・規約を確認してください。");return Response.json(await recordPreviewConsent(request,(await params).id,(body as {sessionId:string}).sessionId),{headers:{"Cache-Control":"no-store"}});}catch(error){return productErrorResponse(error);}}
