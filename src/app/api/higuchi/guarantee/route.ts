import { requirePermission,withOrgContext } from "@/lib/auth/context";
import { assertSameOrigin } from "@/lib/higuchi/service";
import { productErrorResponse } from "@/lib/higuchi/http";
import { readGuarantee,requestGuarantee } from "@/lib/higuchi/guarantee";
export const runtime="nodejs";
export async function GET(request:Request){try{return await withOrgContext(request,async ctx=>{requirePermission(ctx,{integrations:["manage"]});return Response.json(await readGuarantee(),{headers:{"Cache-Control":"no-store"}});});}catch(error){return productErrorResponse(error);}}
export async function POST(request:Request){try{assertSameOrigin(request);return await withOrgContext(request,async ctx=>{requirePermission(ctx,{integrations:["manage"]});return Response.json({request:await requestGuarantee(ctx.userId)},{headers:{"Cache-Control":"no-store"}});});}catch(error){return productErrorResponse(error);}}
