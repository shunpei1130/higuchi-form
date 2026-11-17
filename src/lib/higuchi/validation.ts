import { z } from "zod";
import type { WorkspaceAction } from "./types";
import { ProductError } from "./state";

const entity=z.string().min(1).max(200),requestId=z.string().trim().min(1).max(200),short=z.string().max(300),long=z.string().max(30000),money=z.number().int().min(0).max(1000000);
const targeting=z.object({locations:z.array(short).max(50).optional(),roles:z.array(short).max(50).optional(),companySizes:z.array(short).max(50).optional(),includeCriteria:long.optional(),excludeCriteria:long.optional(),valueProposition:long.optional(),painPoints:long.optional(),emailInstructions:long.optional()}).strict();
const actionSchema=z.discriminatedUnion("type",[
  z.object({type:z.literal("project.create"),name:short.trim().min(1),website:z.string().max(2048).optional(),description:long.optional(),icp:long.optional(),geography:z.string().max(1000).optional()}).strict(),
  z.object({type:z.literal("project.update"),projectId:entity,name:short.optional(),website:z.string().max(2048).optional(),description:long.optional(),icp:long.optional(),dailyBudgetCents:money.optional(),monthlyBudgetCents:z.number().int().min(0).max(10000000).optional(),autopilot:z.boolean().optional(),geography:z.string().max(1000).optional()}).strict(),
  z.object({type:z.literal("project.select"),projectId:entity}).strict(),
  z.object({type:z.literal("campaign.propose"),projectId:entity,name:short.optional(),audience:long.optional(),objective:long.optional(),segmentIndex:z.number().int().min(0).max(2).optional()}).strict(),
  z.object({type:z.literal("campaign.update"),campaignId:entity,name:short.optional(),audience:long.optional(),objective:long.optional(),dailyBudgetCents:money.optional(),emailSubject:z.string().max(1000).optional(),emailBody:long.optional(),autoReply:z.boolean().optional(),followUpDays:z.array(z.number().int().min(1).max(90)).max(5).optional(),sendWeekdays:z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),replyDelayMinutes:z.number().int().min(0).max(1440).optional(),targeting:targeting.optional()}).strict(),
  z.object({type:z.enum(["campaign.start","campaign.stop","campaign.archive","campaign.restore","campaign.approve"]),campaignId:entity}).strict(),
  z.object({type:z.literal("leads.import"),projectId:entity,campaignId:entity.optional(),csv:z.string().max(1000000)}).strict(),
  z.object({type:z.enum(["inbox.read","inbox.suppress"]),conversationId:entity}).strict(),
  z.object({type:z.literal("inbox.reply"),conversationId:entity,body:long.trim().min(1),requestId}).strict(),
  z.object({type:z.literal("inbox.note"),conversationId:entity,notes:z.string().max(10000)}).strict(),
  z.object({type:z.literal("lead.suppress"),leadId:entity}).strict(),
  z.object({type:z.literal("settings.update"),settings:z.object({displayName:short.optional(),companyName:short.optional(),timezone:z.string().max(100).optional(),language:z.literal("ja").optional(),bookingUrl:z.string().max(2048).optional(),autoReply:z.boolean().optional(),emailNotifications:z.boolean().optional()}).strict()}).strict(),
  z.object({type:z.literal("billing.topup"),amountCents:money,requestId}).strict(),
  z.object({type:z.literal("billing.verify"),requestId}).strict(),
  z.object({type:z.literal("billing.setup"),requestId}).strict(),
  z.object({type:z.literal("billing.checkout"),amountCents:money,requestId}).strict(),
  z.object({type:z.literal("billing.portal"),requestId}).strict(),
  z.object({type:z.literal("simulation.tick"),advanceMinutes:z.number().int().min(0).max(43200).optional()}).strict(),
  z.object({type:z.literal("simulation.reply"),leadId:entity,body:long.trim().min(1),requestId}).strict(),
  z.object({type:z.literal("simulation.booking"),leadId:entity,startsAt:z.string().max(100),requestId}).strict(),
  z.object({type:z.literal("simulation.reset")}).strict(),
]);
export function validateAction(value:unknown):WorkspaceAction {
  const rejectUnsafeKeys=(item:unknown,depth=0):void=>{if(depth>10)throw new ProductError("入力の階層が深すぎます。");if(item&&typeof item==="object")for(const key of Object.keys(item)){if(["__proto__","prototype","constructor"].includes(key))throw new ProductError("対応していない入力項目です。",400,"INVALID_INPUT");rejectUnsafeKeys((item as Record<string,unknown>)[key],depth+1);}};
  rejectUnsafeKeys(value);
  const result=actionSchema.safeParse(value);
  if(!result.success)throw new ProductError("入力内容を確認してください。必要な項目が不足しているか、形式が正しくありません。",400,"INVALID_INPUT");
  return result.data;
}
export async function readJsonObject(request:Request):Promise<Record<string,unknown>> {
  if(!request.headers.get("content-type")?.includes("application/json"))throw new ProductError("JSON形式で指定してください。",415);
  const raw=await request.text();if(raw.length>1100000)throw new ProductError("送信内容が大きすぎます。",413);
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new ProductError("送信内容を読み取れませんでした。");}
  if(!value||typeof value!=="object"||Array.isArray(value))throw new ProductError("入力内容が正しくありません。");
  return value as Record<string,unknown>;
}
