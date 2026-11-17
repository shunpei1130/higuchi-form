import { handleResendDeliveryWebhook } from "@/lib/higuchi/notifications";
export const runtime="nodejs";
export async function POST(request:Request){
  if(process.env.HIGUCHI_MODE==="simulation")return Response.json({error:"この環境では受け付けていません。"},{status:409});
  try{await handleResendDeliveryWebhook(request);return Response.json({ok:true});}
  catch{return Response.json({error:"通知を確認できませんでした。"},{status:400});}
}
