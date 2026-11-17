import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { ProductError } from "../state";
import { assertPreviewFixtureConfiguration, isPreviewLoopback, previewFixtureEnabled } from "./fixture";
export function assertPreviewDispatcher(request:Request):void {
  const expected=process.env.CRON_SECRET;if(!expected||expected.length<24)throw new ProductError("調査の継続処理が未設定です。",503,"PREVIEW_DISPATCH_UNCONFIGURED");
  const actual=request.headers.get("authorization")??"";
  if(!timingSafeEqual(createHash("sha256").update(actual).digest(),createHash("sha256").update(`Bearer ${expected}`).digest()))throw new ProductError("認証が必要です。",401,"UNAUTHORIZED");
}
export function previewDispatchUrl(env:Record<string,string|undefined>=process.env):string {
  assertPreviewFixtureConfiguration(env);
  const configured=env.BETTER_AUTH_URL??env.NEXT_PUBLIC_APP_URL;if(!configured)throw new ProductError("調査の公開URLが未設定です。",503,"PREVIEW_DISPATCH_UNCONFIGURED");
  const origin=new URL(configured),localFixture=origin.protocol==="http:"&&isPreviewLoopback(origin.hostname)&&!env.VERCEL&&previewFixtureEnabled(env);
  if((origin.protocol!=="https:"&&!localFixture)||origin.username||origin.password)throw new ProductError("調査の公開URLを確認してください。",503,"PREVIEW_DISPATCH_UNCONFIGURED");
  return new URL("/api/previews/dispatch",origin.origin).href;
}
export async function dispatchPreviewContinuation(runId:string):Promise<void> {
  if(!process.env.CRON_SECRET)return;
  try{await fetch(previewDispatchUrl(),{method:"POST",headers:{Authorization:`Bearer ${process.env.CRON_SECRET}`,"Content-Type":"application/json"},body:JSON.stringify({runId}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(5000)});}catch{
    // The state is already committed. Cron recovers dispatch/network interruptions.
  }
}
