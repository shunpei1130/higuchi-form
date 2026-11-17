import { requireOrgContext, requirePlatformOperator } from "@/lib/auth/context";
import { assertSameOrigin } from "@/lib/higuchi/service";
import { beginGoogleMailAuthorization, disconnectGoogleMail, getGoogleMailStatus } from "@/lib/higuchi/googleMail";
import { productErrorResponse } from "@/lib/higuchi/http";
import { ProductError } from "@/lib/higuchi/state";

export const runtime = "nodejs";
const target = (value:unknown):string => {
  if(typeof value!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new ProductError("対象組織を指定してください。");
  return value;
};
async function operator(request:Request){if(process.env.HIGUCHI_MODE==="simulation")throw new ProductError("検証モードではメール接続を変更しません。",409);const ctx=await requireOrgContext(request);await requirePlatformOperator(ctx);return ctx;}
export async function GET(request:Request){
  try{await operator(request);return Response.json(await getGoogleMailStatus(target(new URL(request.url).searchParams.get("organizationId"))),{headers:{"Cache-Control":"no-store"}});}
  catch(error){return productErrorResponse(error);}
}
export async function POST(request:Request){
  try{
    assertSameOrigin(request);const ctx=await operator(request);
    if(!request.headers.get("content-type")?.includes("application/json"))throw new ProductError("JSON形式で指定してください。",415);
    const raw=await request.text();if(raw.length>4000)throw new ProductError("指定内容が大きすぎます。",413);
    let body:Record<string,unknown>;try{body=JSON.parse(raw);}catch{throw new ProductError("指定内容が正しくありません。");}
    if(!body||typeof body!=="object"||Array.isArray(body))throw new ProductError("指定内容が正しくありません。");
    const organizationId=target(body.organizationId);
    if(body.action==="connect")return Response.json(await beginGoogleMailAuthorization({organizationId,userId:ctx.userId}),{headers:{"Cache-Control":"no-store"}});
    if(body.action==="disconnect"){await disconnectGoogleMail(organizationId);return Response.json({ok:true},{headers:{"Cache-Control":"no-store"}});}
    throw new ProductError("対応していない操作です。");
  }catch(error){return productErrorResponse(error);}
}
