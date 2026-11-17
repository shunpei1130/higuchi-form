import { verifyBillingWebhook } from "@/lib/higuchi/providerBilling";
import { applyVerifiedBillingEvent } from "@/lib/higuchi/service";

export const runtime = "nodejs";
export const maxDuration = 60;
/** Shared merchant endpoint. Customer identity is resolved only after verifying the raw signed body. */
export async function POST(request: Request): Promise<Response> {
  try {
    const event = await verifyBillingWebhook(request);
    if (event) await applyVerifiedBillingEvent(event);
    return Response.json({received:true},{headers:{"Cache-Control":"no-store"}});
  } catch (error) {
    const status = typeof (error as {status?:unknown})?.status === "number" ? (error as {status:number}).status : 500;
    console.error("[higuchi/stripe] notification rejected",error instanceof Error?error.name:"unknown");
    return Response.json({error:status>=500?"決済通知を処理できませんでした。":"決済通知を確認できませんでした。"},{status,headers:{"Cache-Control":"no-store"}});
  }
}
