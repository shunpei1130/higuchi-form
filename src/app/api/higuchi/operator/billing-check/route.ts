import { withOrgContext, requirePlatformOperator } from "@/lib/auth/context";
import { productErrorResponse } from "@/lib/higuchi/http";
import { ProductError } from "@/lib/higuchi/state";
import { billingInspectionFailure, inspectJpyCatalog, validateInspectConfig } from "@/lib/higuchi/billingInspection";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", Vary: "Cookie" };
/** Authenticated platform operator only; four fixed Stripe GETs, no tenant mappings or writes. */
export async function GET(request: Request) {
  try {
    return await withOrgContext(request, async ctx => {
      await requirePlatformOperator(ctx);
      const target = process.env.VERCEL_ENV;
      if (target !== "production" && target !== "preview") throw new ProductError("接続確認は指定の本番・検証環境で利用してください。", 409, "BILLING_CHECK_ENVIRONMENT_REQUIRED");
      try {
        const config = validateInspectConfig(process.env, { target, help: false });
        return Response.json(await inspectJpyCatalog(config), { headers });
      } catch (error) {
        // Provider and environment objects can contain secrets. Emit only the safe
        // constructed code/summary, never the raw error or request/response body.
        return Response.json(billingInspectionFailure(error), { status: 502, headers });
      }
    });
  } catch (error) { return productErrorResponse(error); }
}
