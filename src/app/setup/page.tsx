import { redirect } from "next/navigation";
import { needsSetup } from "@/lib/auth/setup";
import { SetupForm } from "./SetupForm";
import { bootstrapEnabledForWeb } from "@/lib/auth/operatorBootstrapPolicy";

// Reads the database on every request: it must go dead the moment a user exists.
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if(process.env.HIGUCHI_MODE==="simulation")redirect("/app");
  if(!bootstrapEnabledForWeb({nodeEnv:process.env.NODE_ENV,vercel:process.env.VERCEL}))redirect("/sign-in");
  if (!(await needsSetup())) redirect("/sign-in");
  return <SetupForm />;
}
