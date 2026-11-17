import { timingSafeEqual } from "node:crypto";
import { runHiguchiJobs } from "@/lib/higuchi/jobs/worker";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=120;
export async function GET(request:Request){
  const expected=process.env.CRON_SECRET,token=request.headers.get("authorization")?.replace(/^Bearer /,"");
  if(!expected||!token||Buffer.byteLength(token)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(token),Buffer.from(expected)))return Response.json({error:"認証が必要です。"},{status:401});
  if(process.env.VERCEL_ENV!=="production")return Response.json({error:"本番環境だけで実行できます。"},{status:409});
  try{return Response.json(await runHiguchiJobs());}catch{return Response.json({error:"定期処理を開始できませんでした。"},{status:503});}
}
