import { ProspectLibrary } from "@/components/operator/ProspectLibrary";
import { requirePageOrgContext, requirePlatformOperator } from "@/lib/auth/context";
export const dynamic="force-dynamic";
export default async function ProspectLibraryPage(){const ctx=await requirePageOrgContext();await requirePlatformOperator(ctx);return <ProspectLibrary/>;}
