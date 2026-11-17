import "server-only";
import { runInOrganization } from "@/lib/tenancy/scope";
import { getHiguchiMode } from "./mode";
import { getBillingCredentials, getBillingReadiness } from "./billingCredentials";
import type { ConnectionState, IntegrationStates } from "./types";

export { HiguchiIntegrationError } from "./integrationError";
export { analyzeBusiness, generateOutreachEmail, generateReply } from "./analysis";
export { sendOutreach, assignProviderMailbox, listProviderMailboxes, syncProviderInbox, lookupOutreachDelivery } from "./providerMailboxes";
export { getBillingCredentials, requireBillingCredentials, saveHiguchiBillingIntegration, platformBillingCredentials, getBillingReadiness } from "./billingCredentials";
export type { BillingCredentials, BillingConnection } from "./billingCredentials";

const connected=(ok:boolean,detail:string):ConnectionState=>({connected:ok,status:ok?"ready":"unconfigured",detail});
type Readers={ [K in keyof IntegrationStates]:(organizationId:string)=>Promise<ConnectionState> };
const readers:Readers={
  ai:async()=>{
    const {openAiConfigured}=await import("./openai");
    const allowedModel=(process.env.HIGUCHI_OPENAI_MODEL??"gpt-6-luna")==="gpt-6-luna";
    const limit=Number(process.env.HIGUCHI_AI_MONTHLY_USD??20),production=!process.env.VERCEL_ENV||process.env.VERCEL_ENV==="production";
    const ready=openAiConfigured()&&allowedModel&&Number.isFinite(limit)&&limit>0&&limit<=20&&production;
    return connected(ready,ready?"OpenAI APIのgpt-6-lunaを使用します。全組織の合計で月間20米ドル以内に制限します。":production?"OpenAI APIの運営用接続・対応モデル・月間上限を設定してください。":"Preview環境ではAIの実呼び出しを停止しています。");
  },
  email:async organizationId=>{
    const {getGoogleMailStatus}=await import("./googleMail");
    const status=await getGoogleMailStatus(organizationId);
    return connected(status.connected,status.detail);
  },
  booking:async()=>{
    const [{getBookingSettings},{bookingSecret,bookingOrigin}]=await Promise.all([import("./booking/service"),import("./booking/tokens")]);
    const settings=await getBookingSettings();
    if(!settings.enabled)return connected(false,"ワークスペースの設定で、商談予約の受付日時と担当者を設定して公開してください。");
    try{bookingSecret();bookingOrigin();}catch{return connected(false,"内蔵予約ページの公開URL・予約リンクの接続設定を確認してください。");}
    if(!process.env.RESEND_API_KEY)return connected(false,"内蔵予約の設定は保存済みです。予約確認メールを送るResendの運営用接続を設定してください。");
    return connected(true,"内蔵予約ページで、予約・日程変更・取消を受け付けます。通知メールはResendで配信します。");
  },
  billing:async organizationId=>{
    const readiness=getBillingReadiness();if(!readiness.connected)return readiness;
    // Validate an existing mapping without exposing IDs or keys. An absent mapping is created at the first Checkout.
    await getBillingCredentials(organizationId);return readiness;
  },
};

/** Readiness only: no provider provisioning, mail delivery, AI completion or payment is performed here. */
export async function getIntegrationStates(organizationId:string,overrides?:Partial<Readers>):Promise<IntegrationStates>{
  if(getHiguchiMode()==="simulation"){
    const simulation:ConnectionState={connected:true,status:"simulation",detail:"シミュレーション。外部への送信・決済は行いません。"};
    return {ai:{...simulation},email:{...simulation},booking:{...simulation},billing:{...simulation}};
  }
  return runInOrganization(organizationId,async()=>{
    const sources={...readers,...overrides},keys=["ai","email","booking","billing"] as const;
    const results=await Promise.allSettled(keys.map(key=>sources[key](organizationId)));
    return Object.fromEntries(keys.map((key,index)=>{
      const result=results[index];
      return [key,result.status==="fulfilled"?result.value:connected(false,"接続状態を確認できません。運営者設定で、この組織の接続情報を確認してください。")];
    })) as IntegrationStates;
  });
}
