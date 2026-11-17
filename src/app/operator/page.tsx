import { OperatorSetup } from "@/components/operator/OperatorSetup";
import { isHiguchiSimulation } from "@/lib/higuchi/mode";
import Link from "next/link";

export const dynamic = "force-dynamic";
export default async function OperatorPage() {
  // Simulation must never initialize the database or authentication provider.
  if (isHiguchiSimulation()) return <OperatorSetup simulation />;
  const {requirePageOrgContext,requirePlatformOperator,isAuthContextError}=await import("@/lib/auth/context");
  const context=await requirePageOrgContext();
  try{await requirePlatformOperator(context);}
  catch(error){if(isAuthContextError(error)&&error.status===403)return <OperatorSetup simulation={false} forbidden />;throw error;}
  return <><OperatorSetup simulation={false} organizationId={context.organizationId} organizationName={context.organizationName} /><nav aria-label="運営の管理" style={{maxWidth:1080,margin:"0 auto 48px",padding:"0 24px",display:"flex",gap:24,flexWrap:"wrap"}}><Link href="/operator/catalog">試用画面の顧客データを管理 →</Link><Link href="/operator/refunds">返金保証の申請を確認 →</Link></nav></>;
}
