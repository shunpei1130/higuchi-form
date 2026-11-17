import { requireOrgContext, requirePlatformOperator } from "@/lib/auth/context";
import { assertSameOrigin } from "@/lib/higuchi/service";
import { isHiguchiSimulation } from "@/lib/higuchi/mode";
import { ProductError } from "@/lib/higuchi/state";
import { productErrorResponse } from "@/lib/higuchi/http";
import { getIntegrationStates, listProviderMailboxes, saveHiguchiBillingIntegration } from "@/lib/higuchi/integrations";
import { getAiBudget } from "@/lib/higuchi/openai";

export const runtime="nodejs";
const target=(input:unknown)=>{if(typeof input!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input))throw new ProductError("対象組織を指定してください。");return input;};
async function authorize(request:Request){if(isHiguchiSimulation())throw new ProductError("接続の管理は本番接続モードで実行してください。",409);const ctx=await requireOrgContext(request);await requirePlatformOperator(ctx);}
export async function GET(request:Request){try{
  await authorize(request);const requested=new URL(request.url).searchParams.get("organizationId");
  if(!requested){const [{db},{organizations}]=await Promise.all([import("@/lib/db"),import("@/lib/auth/schema")]);return Response.json({organizations:await db.select({id:organizations.id,name:organizations.name}).from(organizations).orderBy(organizations.name)},{headers:{"Cache-Control":"no-store"}});}
  const organizationId=target(requested);const [mailboxes,integrations,aiBudget]=await Promise.all([listProviderMailboxes(organizationId),getIntegrationStates(organizationId),getAiBudget()]);return Response.json({mailboxes,integrations,aiBudget},{headers:{"Cache-Control":"no-store"}});
}catch(error){return productErrorResponse(error);}}
export async function POST(request:Request){try{
  assertSameOrigin(request);await authorize(request);
  if(!request.headers.get("content-type")?.includes("application/json"))throw new ProductError("JSON形式で指定してください。",415);
  const raw=await request.text();if(raw.length>100000)throw new ProductError("接続情報が大きすぎます。",413);
  let body:Record<string,unknown>;try{body=JSON.parse(raw);}catch{throw new ProductError("接続情報が正しくありません。");}
  if(!body||typeof body!=="object"||Array.isArray(body))throw new ProductError("接続情報が正しくありません。");
  const organizationId=target(body.organizationId);
  if(body.action==="billing.save"){
    if(!body.credentials||typeof body.credentials!=="object"||Array.isArray(body.credentials))throw new ProductError("接続情報を指定してください。");
    await saveHiguchiBillingIntegration(organizationId,body.credentials as Record<string,unknown>);
  }else throw new ProductError("対応していない管理操作です。");
  return Response.json({ok:true});
}catch(error){return productErrorResponse(error);}}
