import "server-only";
import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { higuchiAiUsage } from "./jobs/schema";
import { ProductError } from "./state";

const MODEL = "gpt-6-luna";
const MICROS_PER_USD = 1_000_000;
// Standard pricing published by OpenAI, 2026-11-17. Only this configured model is permitted.
export const AI_PRICING = { inputPerMillion:0.10, outputPerMillion:0.50 } as const;
export function reservedAiMicros(system:string,user:string,maxOutputTokens:number):number {
  // UTF-8 bytes bound text token counts conservatively; include schema/protocol framing.
  const inputBound = Buffer.byteLength(system+user,"utf8")+10000;
  return Math.ceil(inputBound*AI_PRICING.inputPerMillion+maxOutputTokens*AI_PRICING.outputPerMillion);
}
export function actualAiMicros(inputTokens:number,outputTokens:number):number {
  return Math.ceil(inputTokens*AI_PRICING.inputPerMillion+outputTokens*AI_PRICING.outputPerMillion);
}
export function openAiConfigured():boolean { return Boolean(process.env.OPENAI_API_KEY?.startsWith("sk-")); }
export async function getAiBudget(){
  const month=new Date().toISOString().slice(0,7);
  const [row]=await db.select({used:sql<number>`coalesce(sum(coalesce(${higuchiAiUsage.actualMicros},${higuchiAiUsage.reservedMicros})),0)::int`}).from(higuchiAiUsage).where(eq(higuchiAiUsage.month,month));
  return {month,usedMicros:Number(row?.used??0),limitMicros:Math.min(20,Number(process.env.HIGUCHI_AI_MONTHLY_USD??20))*MICROS_PER_USD};
}
export async function completeWithOpenAi(input:{organizationId:string;systemPrompt:string;userPrompt:string;jsonSchema:Record<string,unknown>;schemaName:string;maxOutputTokens:number}):Promise<{text:string}> {
  if(!openAiConfigured())throw new ProductError("OpenAIの接続が未設定です。",409,"AI_UNCONFIGURED");
  if(process.env.VERCEL_ENV&&process.env.VERCEL_ENV!=="production")throw new ProductError("PreviewではAIの実呼び出しを停止しています。",409,"PREVIEW_DISABLED");
  const model=process.env.HIGUCHI_OPENAI_MODEL??MODEL;
  if(model!==MODEL)throw new ProductError("利用料金を確認済みのAIモデルを設定してください。",409,"MODEL_UNPRICED");
  const requestKey=randomUUID(),month=new Date().toISOString().slice(0,7);
  const reserved=reservedAiMicros(input.systemPrompt,input.userPrompt,input.maxOutputTokens);
  const limit=Math.min(20,Number(process.env.HIGUCHI_AI_MONTHLY_USD??20))*MICROS_PER_USD;
  if(!Number.isFinite(limit)||limit<=0)throw new ProductError("AI予算が設定されていません。",409,"AI_BUDGET");
  const usageId=await db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`higuchi-ai:${month}`},0))`);
    const [row]=await tx.select({used:sql<number>`coalesce(sum(coalesce(${higuchiAiUsage.actualMicros},${higuchiAiUsage.reservedMicros})),0)::int`}).from(higuchiAiUsage).where(eq(higuchiAiUsage.month,month));
    if(Number(row?.used??0)+reserved>limit)throw new ProductError("今月のAI利用上限20米ドルに達しました。",409,"AI_BUDGET_EXCEEDED");
    const [saved]=await tx.insert(higuchiAiUsage).values({organizationId:input.organizationId,requestKey,month,model,reservedMicros:reserved}).returning({id:higuchiAiUsage.id});return saved.id;
  });
  try{
    const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY,maxRetries:0,timeout:45000});
    const response=await client.responses.create({model,store:false,reasoning:{effort:"low"},max_output_tokens:input.maxOutputTokens,
      input:[{role:"system",content:input.systemPrompt},{role:"user",content:input.userPrompt}],
      text:{format:{type:"json_schema",name:input.schemaName,schema:input.jsonSchema,strict:true}}});
    const used=response.usage?actualAiMicros(response.usage.input_tokens,response.usage.output_tokens):reserved;
    await db.update(higuchiAiUsage).set({actualMicros:used,status:"completed",inputTokens:response.usage?.input_tokens,outputTokens:response.usage?.output_tokens}).where(and(eq(higuchiAiUsage.id,usageId),eq(higuchiAiUsage.organizationId,input.organizationId)));
    if(response.status!=="completed"||!response.output_text)throw new ProductError("AIの応答が完了しませんでした。再確認が必要です。",502,"AI_INCOMPLETE");
    return {text:response.output_text};
  }catch(error){
    // Timeouts may have consumed tokens. Keep the reservation to avoid overspending on retries.
    await db.update(higuchiAiUsage).set({status:"uncertain"}).where(and(eq(higuchiAiUsage.id,usageId),eq(higuchiAiUsage.status,"reserved")));
    if(error instanceof ProductError)throw error;
    throw new ProductError("AIの応答を取得できませんでした。接続状況と利用枠を確認してください。",502,"AI_PROVIDER_ERROR");
  }
}
