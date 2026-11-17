import { timingSafeEqual } from "node:crypto";
import { runHiguchiJobs } from "@/lib/higuchi/jobs/worker";
import { runPreviewWorker } from "@/lib/higuchi/preview/worker";
import { scrubExpiredPreviews } from "@/lib/higuchi/preview/retention";
import { runHiguchiCronTasks } from "@/lib/higuchi/cronTasks";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=120;
export async function GET(request:Request){
  const expected=process.env.CRON_SECRET,authorization=request.headers.get("authorization"),token=authorization?.startsWith("Bearer ")?authorization.slice(7):null;
  if(!expected||!token||Buffer.byteLength(token)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(token),Buffer.from(expected)))return Response.json({error:"認証が必要です。"},{status:401});
  if(process.env.VERCEL_ENV!=="production")return Response.json({error:"本番環境だけで実行できます。"},{status:409});
  if(process.env.HIGUCHI_MODE!=="live")return Response.json({error:"本番接続だけで実行できます。"},{status:409});
  // Jobs admit work for 30s and finish their <=65s provider operation; one preview stage
  // runs alongside them. Cleanup has short DB timeouts. No three-phase serial chain.
  try{const result=await runHiguchiCronTasks({jobs:runHiguchiJobs,preview:()=>runPreviewWorker({maxStages:1}),retention:()=>scrubExpiredPreviews()});return Response.json(result,{status:result.failedTasks.length?503:200,headers:{"Cache-Control":"no-store"}});}catch{return Response.json({error:"定期処理を開始できませんでした。"},{status:503});}
}
