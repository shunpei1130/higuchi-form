import { OperatorSetup } from "@/components/operator/OperatorSetup";
import { isHiguchiSimulation } from "@/lib/higuchi/mode";

export const dynamic = "force-dynamic";
export default async function OperatorPage() {
  // Simulation must never initialize the database or authentication provider.
  if (isHiguchiSimulation()) return <OperatorSetup simulation />;
  const {requirePageOrgContext,requirePlatformOperator,isAuthContextError}=await import("@/lib/auth/context");
  const context=await requirePageOrgContext();
  try{await requirePlatformOperator(context);}
  catch(error){if(isAuthContextError(error)&&error.status===403)return <OperatorSetup simulation={false} forbidden />;throw error;}
  return <OperatorSetup simulation={false} organizationId={context.organizationId} organizationName={context.organizationName} />;
}
