import { requireOrgContext, requirePlatformOperator } from "@/lib/auth/context";
import { completeGoogleMailAuthorization } from "@/lib/higuchi/googleMail";
import { productErrorResponse } from "@/lib/higuchi/http";
import { ProductError } from "@/lib/higuchi/state";

export const runtime = "nodejs";
export async function GET(request:Request){
  try{
    if(process.env.HIGUCHI_MODE==="simulation")throw new ProductError("検証モードではメール接続を変更しません。",409);
    const ctx=await requireOrgContext(request);await requirePlatformOperator(ctx);
    const params=new URL(request.url).searchParams;
    if(params.has("error"))throw new ProductError("Googleメールの接続が許可されませんでした。運営設定から再度お試しください。",409);
    const state=params.get("state"),code=params.get("code");
    if(!state||!code||code.length>4096)throw new ProductError("Googleメールの接続情報が正しくありません。");
    const result=await completeGoogleMailAuthorization({state,code,userId:ctx.userId});
    return new Response(null,{status:303,headers:{Location:`/operator?mail=connected&organizationId=${encodeURIComponent(result.organizationId)}`,"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
  }catch(error){const response=await productErrorResponse(error);response.headers.set("Referrer-Policy","no-referrer");return response;}
}
