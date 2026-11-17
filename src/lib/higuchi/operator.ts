import { runInOrganization } from "@/lib/tenancy/scope";
import { ProductError } from "./state";

/** Called only after platform-operator authorization by the admin route. */
export async function saveOperatorAi(organizationId:string,input:Record<string,unknown>):Promise<void>{
  const required=(key:string)=>{const value=input[key];if(typeof value!=="string"||!value.trim()||value.length>4096)throw new ProductError(`${key}を指定してください。`);return value.trim();};
  const apiKey=required("apiKey"),managementKey=required("managementKey"),provider=required("provider"),modelId=required("modelId");
  if(input.byokOnlyConfirmed!==true)throw new ProductError("OpenRouterでBYOK専用ルーティングを設定したことを確認してください。");
  await runInOrganization(organizationId,async()=>{
    const [{createAiConnection},{saveByokSettings},{listOpenRouterByokCatalog}]=await Promise.all([import("@/lib/ai/connections"),import("@/lib/ai/byok"),import("@/lib/ai/server/openrouter")]);
    const catalog=await listOpenRouterByokCatalog(managementKey);const selected=catalog.find(p=>p.slug===provider)?.models.find(m=>m.id===modelId);
    if(!selected?.outputModalities?.includes("text")||!selected.supportedParameters?.includes("tools"))throw new ProductError("この接続で利用できる関数呼び出し対応のテキストモデルを指定してください。");
    const connection=await createAiConnection({providerKey:"openrouter",name:"higuchi-form 運営用AI",credentials:{apiKey,managementKey}});
    await saveByokSettings({connectionId:connection.id,providers:[provider],modelsByProvider:{[provider]:[modelId]},defaultModel:{provider,modelId},transcriptionModel:null,byokOnlyConfirmed:true});
  });
}
