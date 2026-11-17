import { z } from "zod";
import { withOrgContext, requirePermission } from "@/lib/auth/context";
import { assertSameOrigin } from "@/lib/higuchi/service";
import { productErrorResponse } from "@/lib/higuchi/http";
import { readJsonObject } from "@/lib/higuchi/validation";
import { activateJpyBilling, ProductError } from "@/lib/higuchi/state";
import { mutateLive } from "@/lib/higuchi/store";
import { createBillingCheckout, createBillingSetup, readBillingElementsSession, expireBillingElementsSession } from "@/lib/higuchi/providerBilling";
import { preparePreviewCheckout } from "@/lib/higuchi/previewCheckout";
import { isHiguchiSimulation } from "@/lib/higuchi/mode";
import { getIntegrationStates } from "@/lib/higuchi/integrations";
export const runtime="nodejs";
export const maxDuration=180;
const inputSchema=z.object({mode:z.enum(["setup","payment"]),amountMinor:z.number().int().optional(),requestId:z.string().uuid(),returnPath:z.string().max(2000).optional(),previewRunId:z.string().uuid().optional()}).strict();

export async function POST(request:Request){
  try{
    assertSameOrigin(request);
    if(isHiguchiSimulation())throw new ProductError("サンプルではカード入力と課金を行いません。",409,"SAMPLE_BILLING_DISABLED");
    const parsed=inputSchema.safeParse(await readJsonObject(request));if(!parsed.success)throw new ProductError("決済内容を確認してください。");
    return await withOrgContext(request,async ctx=>{
      requirePermission(ctx,{integrations:["manage"]});
      const input=parsed.data;
      if(input.previewRunId){const {assertClaimedRealPreview}=await import("@/lib/higuchi/previewClaim");await assertClaimedRealPreview(request,input.previewRunId,ctx.organizationId);}
      if(input.mode==="payment"||input.previewRunId){const states=await getIntegrationStates(ctx.organizationId);if(!states.email.connected||!states.booking.connected)throw new ProductError("送信元メールと予約の接続を完了してから開始してください。カードへの請求は行っていません。",409,"SEND_SETUP_REQUIRED");}
      const base=new URL(process.env.BETTER_AUTH_URL??process.env.NEXT_PUBLIC_APP_URL??request.url);
      const target=new URL(input.returnPath??"/app/billing",base.origin);
      if(target.origin!==base.origin||!(target.pathname==="/app/billing"||target.pathname.startsWith("/auto-gtm/")))throw new ProductError("決済後の戻り先を確認してください。");
      target.searchParams.set("billing_return","1");
      const common={organizationId:ctx.organizationId,currency:"JPY" as const,requestId:input.requestId,returnUrl:target.href,email:ctx.userEmail,uiMode:"elements" as const,previewRunId:input.previewRunId};
      let session;
      if(input.previewRunId){
        const runId=input.previewRunId,sessionInput=(sessionId:string)=>({organizationId:ctx.organizationId,sessionId,currency:"JPY" as const,previewRunId:runId});
        session=await preparePreviewCheckout({runId,mode:input.mode,amountMinor:input.amountMinor,requestId:input.requestId,returnUrl:target.href},{
          mutate:async fn=>(await mutateLive(fn)).result,
          create:async pending=>{const fixed={...common,requestId:pending.requestId!,returnUrl:pending.returnUrl!};return pending.mode==="setup"?createBillingSetup(fixed):createBillingCheckout({...fixed,amountCents:pending.amountMinor,firstPaymentBonus:pending.firstPaymentBonus});},
          read:sessionId=>readBillingElementsSession(sessionInput(sessionId)),expire:sessionId=>expireBillingElementsSession(sessionInput(sessionId)),
        });
      }else{
        const snapshot=await mutateLive(state=>{activateJpyBilling(state);return structuredClone(state.billing);});
        if(snapshot.result.reconciliationRequired)throw new ProductError("返金・残高の照合が完了するまで前払いを停止しています。カードへの請求は行っていません。",409,"BILLING_RECONCILIATION_REQUIRED");
        session=input.mode==="setup"?await createBillingSetup(common):await createBillingCheckout({...common,amountCents:input.amountMinor??0,firstPaymentBonus:!snapshot.result.firstTopupCompleted&&!snapshot.result.trialClaimed});
      }
      if(!session.clientSecret||!session.publishableKey?.startsWith("pk_"))throw new ProductError("カード入力の接続設定が未完了です。運営者にご連絡ください。",409,"BILLING_ELEMENTS_UNCONFIGURED");
      return Response.json({clientSecret:session.clientSecret,publishableKey:session.publishableKey,sessionId:session.sessionId,currency:session.currency,priceVersion:session.priceVersion},{headers:{"Cache-Control":"private, no-store"}});
    });
  }catch(error){return productErrorResponse(error);}
}
