import { safeFrom } from "@/components/auth/safeFrom";
import { isHiguchiSimulation } from "@/lib/higuchi/mode";
import { SignInForm } from "../sign-in/SignInForm";
export default async function SignUpPage({searchParams}:{searchParams:Promise<{from?:string}>}) {
  const {from}=await searchParams;
  return <SignInForm signup from={safeFrom(from)} simulation={isHiguchiSimulation()} linkedinEnabled={Boolean(process.env.LINKEDIN_CLIENT_ID&&process.env.LINKEDIN_CLIENT_SECRET)}/>;
}
