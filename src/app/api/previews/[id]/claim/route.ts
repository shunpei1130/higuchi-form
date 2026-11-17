import { assertSameOrigin } from "@/lib/higuchi/service";
import { productErrorResponse } from "@/lib/higuchi/http";
import { ProductError } from "@/lib/higuchi/state";
import { claimPreviewForRequest } from "@/lib/higuchi/previewClaim";
import { readPreviewBody } from "@/lib/higuchi/preview/http";
export const runtime="nodejs";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{assertSameOrigin(request);const raw=await readPreviewBody(request);if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new ProductError("取り込みの確認情報を指定してください。");const body=raw as Record<string,unknown>;if(!Number.isSafeInteger(body.revision)||typeof body.requestId!=="string"||body.requestId.length<1||body.requestId.length>160)throw new ProductError("取り込みの確認情報を指定してください。");return Response.json(await claimPreviewForRequest(request,(await params).id,{revision:body.revision as number,requestId:body.requestId}),{headers:{"Cache-Control":"no-store"}});}catch(error){return productErrorResponse(error);}}
