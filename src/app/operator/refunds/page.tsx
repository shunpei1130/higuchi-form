import { RefundRequests } from "@/components/operator/RefundRequests";
import { requirePageOrgContext,requirePlatformOperator } from "@/lib/auth/context";
export const dynamic="force-dynamic";
export default async function RefundRequestsPage(){const ctx=await requirePageOrgContext();await requirePlatformOperator(ctx);return <RefundRequests/>;}
