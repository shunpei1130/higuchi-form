import { safeFrom } from "@/components/auth/safeFrom";
import { SignInForm } from "./SignInForm";
import { isHiguchiSimulation } from "@/lib/higuchi/mode";
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const {from}=await searchParams;
  return <SignInForm from={safeFrom(from)} simulation={isHiguchiSimulation()} linkedinEnabled={Boolean(process.env.LINKEDIN_CLIENT_ID&&process.env.LINKEDIN_CLIENT_SECRET)}/>;
}
