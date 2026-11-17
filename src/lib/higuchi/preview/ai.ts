import "server-only";
import OpenAI from "openai";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { higuchiAiUsage } from "../jobs/schema";
import { ProductError } from "../state";
import { higuchiPreviewAiUsage, higuchiPreviewRuns } from "./schema";
import { assertPreviewBudget, previewAiActual, previewAiReservation } from "./budget";
import type { PreviewSource } from "./types";
const MODEL="gpt-6-luna";
export type PreviewAiInput={runId:string;generation:number;stage:string;system:string;user:string;jsonSchema:Record<string,unknown>;maxOutputTokens:number;maxSearchCalls?:number};
export async function completePreviewAi(input:PreviewAiInput):Promise<{text:string;sources:PreviewSource[]}> {
  if(process.env.HIGUCHI_MODE!=="live"||!process.env.OPENAI_API_KEY?.startsWith("sk-"))throw new ProductError("公開情報の調査を実行するAIが未設定です。",409,"AI_UNCONFIGURED");
  if(process.env.VERCEL_ENV&&process.env.VERCEL_ENV!=="production")throw new ProductError("Preview環境ではAI調査を停止しています。",409,"PREVIEW_DISABLED");
  if((process.env.HIGUCHI_OPENAI_MODEL??MODEL)!==MODEL)throw new ProductError("料金確認済みのAIモデルを設定してください。",409,"MODEL_UNPRICED");
  let searches=input.maxSearchCalls??0;
  if(!Number.isInteger(searches)||searches<0||searches>3)throw new Error("Invalid search limit");
  const month=new Date().toISOString().slice(0,7),requestKey=`preview:${input.runId}:${input.generation}:${input.stage}`;let reservation=previewAiReservation({...input,maxSearchCalls:searches});
  const usageId=await db.transaction(async tx=>{
    // This is exactly the same global lock used by authenticated AI work.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`higuchi-ai:${month}`},0))`);
    const [run]=await tx.select({generation:higuchiPreviewRuns.generation,status:higuchiPreviewRuns.status,expiresAt:higuchiPreviewRuns.expiresAt}).from(higuchiPreviewRuns).where(eq(higuchiPreviewRuns.id,input.runId)).for("update");
    if(!run||run.generation!==input.generation||run.expiresAt<=new Date()||run.status!=="running")throw new ProductError("調査が更新されました。",409,"PREVIEW_STALE");
    const [prior]=await tx.select({id:higuchiPreviewAiUsage.id}).from(higuchiPreviewAiUsage).where(and(eq(higuchiPreviewAiUsage.runId,input.runId),eq(higuchiPreviewAiUsage.requestKey,requestKey)));
    if(prior)throw new ProductError("前回のAI処理の結果が不明なため、自動で繰り返しません。再試行してください。",409,"AI_UNCERTAIN");
    const [org]=await tx.select({used:sql<number>`coalesce(sum(coalesce(${higuchiAiUsage.actualMicros},${higuchiAiUsage.reservedMicros})),0)::int`}).from(higuchiAiUsage).where(eq(higuchiAiUsage.month,month));
    const [anon]=await tx.select({used:sql<number>`coalesce(sum(coalesce(${higuchiPreviewAiUsage.actualMicros},${higuchiPreviewAiUsage.reservedMicros})),0)::int`}).from(higuchiPreviewAiUsage).where(eq(higuchiPreviewAiUsage.month,month));
    const [perRun]=await tx.select({used:sql<number>`coalesce(sum(coalesce(${higuchiPreviewAiUsage.actualMicros},${higuchiPreviewAiUsage.reservedMicros})),0)::int`,searches:sql<number>`coalesce(sum(${higuchiPreviewAiUsage.searchCalls}),0)::int`}).from(higuchiPreviewAiUsage).where(eq(higuchiPreviewAiUsage.runId,input.runId));
    if(searches){searches=Math.min(searches,3-Number(perRun?.searches??0));if(searches<=0)throw new ProductError("この調査のWeb検索上限に達しました。新しい調査を開始してください。",429,"PREVIEW_SEARCH_LIMIT");reservation=previewAiReservation({...input,maxSearchCalls:searches});}
    try{assertPreviewBudget(Number(perRun?.used??0),Number(org?.used??0)+Number(anon?.used??0),reservation,Math.min(20,Number(process.env.HIGUCHI_AI_MONTHLY_USD??20))*1000000);}catch(e){throw new ProductError("無料調査のAI利用上限に達しました。時間をおいてお試しください。",429,e instanceof Error?e.message:"AI_BUDGET");}
    const [saved]=await tx.insert(higuchiPreviewAiUsage).values({runId:input.runId,requestKey,month,model:MODEL,reservedMicros:reservation,searchCalls:searches}).returning({id:higuchiPreviewAiUsage.id});return saved.id;
  });
  try {
    const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY,maxRetries:0,timeout:45000});
    const response=await client.responses.create({model:MODEL,store:false,reasoning:{effort:"low"},max_output_tokens:input.maxOutputTokens,
      input:[{role:"system",content:input.system},{role:"user",content:input.user}],
      ...(searches?{tools:[{type:"web_search" as const,search_context_size:"low" as const,user_location:{type:"approximate" as const,country:"JP",timezone:"Asia/Tokyo"}}],max_tool_calls:searches,tool_choice:"required" as const,include:["web_search_call.action.sources" as const]}:{}),
      text:{format:{type:"json_schema",name:`preview_${input.stage}`,schema:input.jsonSchema,strict:true}}});
    const searchCalls=response.output.filter(item=>item.type==="web_search_call"&&item.action.type==="search").length;
    const used=response.usage?previewAiActual(response.usage.input_tokens,response.usage.output_tokens,searchCalls):reservation;
    await db.update(higuchiPreviewAiUsage).set({status:"completed",actualMicros:used,inputTokens:response.usage?.input_tokens,outputTokens:response.usage?.output_tokens,searchCalls}).where(and(eq(higuchiPreviewAiUsage.id,usageId),eq(higuchiPreviewAiUsage.runId,input.runId)));
    if(response.status!=="completed"||!response.output_text)throw new ProductError("調査の応答を完了できませんでした。",502,"AI_INCOMPLETE");
    const sources:PreviewSource[]=[];
    for(const item of response.output){if(item.type==="web_search_call"&&item.action.type==="search")for(const s of item.action.sources??[]){try{const url=new URL(s.url);if(url.protocol==="https:"||url.protocol==="http:")sources.push({title:url.hostname,url:url.href});}catch{}}}
    if(searches&&(!searchCalls||!sources.length))throw new ProductError("Web検索の根拠を確認できませんでした。",502,"PREVIEW_SEARCH_INCOMPLETE");
    return {text:response.output_text,sources:[...new Map(sources.map(s=>[s.url,s])).values()].slice(0,20)};
  } catch(error){
    await db.update(higuchiPreviewAiUsage).set({status:"uncertain"}).where(and(eq(higuchiPreviewAiUsage.id,usageId),eq(higuchiPreviewAiUsage.runId,input.runId),eq(higuchiPreviewAiUsage.status,"reserved")));
    if(error instanceof ProductError)throw error;throw new ProductError("公開情報の調査に失敗しました。時間をおいて再試行してください。",502,"AI_PROVIDER_ERROR");
  }
}
