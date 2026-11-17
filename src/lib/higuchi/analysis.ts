import "server-only";

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { z } from "zod";
import { assertPublicUrl } from "@/lib/grid/runners/http";
import { runInOrganization } from "@/lib/tenancy/scope";
import { getHiguchiMode } from "./mode";
import { completeWithOpenAi } from "./openai";
import { HIGUCHI_PROMPTS } from "@/lib/prompts/higuchi";

function getPrompt(name:keyof typeof HIGUCHI_PROMPTS,vars?:{context:string}) { return {text:HIGUCHI_PROMPTS[name].template.replace("{{context}}",vars?.context??"")}; }

export type BusinessAnalysisInput = { organizationId: string; website?: string; business?: string; customer?: string; geo?: string };
const segmentSchema = z.object({
  name: z.string().min(1).max(120), valueProposition: z.string().max(1500), painPoints: z.string().max(1500),
  roles: z.array(z.string().max(100)).max(10), locations: z.array(z.string().max(100)).max(10),
  companySizes: z.array(z.string().max(100)).max(10), includeCriteria: z.string().max(1500),
  excludeCriteria: z.string().max(1500), emailInstructions: z.string().max(2000),
});
const analysisSchema = z.object({
  business: z.string().min(1).max(4000), customer: z.string().min(1).max(3000), geo: z.string().max(1000),
  summary: z.string().min(1).max(3000), segments: z.array(segmentSchema).min(1).max(3),
});
export type BusinessAnalysis = z.infer<typeof analysisSchema> & { sources: string[] };

export function normalizeWebsite(input: string): URL {
  if (/^[a-z][a-z0-9+.-]*:/i.test(input.trim()) && !/^https?:\/\//i.test(input.trim())) throw new Error("公開されたhttp/httpsの会社URLを入力してください。");
  const url = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) {
    throw new Error("公開されたhttp/httpsの会社URLを入力してください。");
  }
  url.hash = "";
  return url;
}

export function websiteText(html: string): string {
  return html.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ").replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|#160);/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim().slice(0, 24000);
}

async function publicPageRequest(url:URL,signal:AbortSignal):Promise<{status:number;location:string|null;contentType:string;body:string}> {
  signal.throwIfAborted();
  const addresses = await new Promise<LookupAddress[]>((resolve,reject)=>{
    const abort=()=>reject(new Error("会社サイトの取得時間を超えました。"));signal.addEventListener("abort",abort,{once:true});
    lookup(url.hostname.replace(/^\[|\]$/g,""),{all:true,verbatim:true}).then(resolve,reject).finally(()=>signal.removeEventListener("abort",abort));
  });
  signal.throwIfAborted();
  await assertPublicUrl(url,async()=>addresses.map(entry=>entry.address),false);
  const address = addresses[0];
  // Pin the socket to the validated DNS answer, closing the rebinding gap between validation and fetch.
  return new Promise((resolve,reject)=>{
    const request = (url.protocol === "https:"?httpsRequest:httpRequest)(url,{method:"GET",agent:false,
      family:address.family,lookup:(_host,options,callback)=>callback(null,options.all?addresses:address.address,address.family),
      signal,headers:{Accept:"text/html,text/plain","User-Agent":"higuchi-form/1.0 (business website analysis)"}},response=>{
      const status=response.statusCode??0,location=response.headers.location??null,contentType=response.headers["content-type"]??"";
      const chunks:Buffer[]=[];let total=0;
      const finish=()=>resolve({status,location,contentType,body:Buffer.concat(chunks).toString("utf8")});
      response.on("data",(chunk:Buffer)=>{const remaining=262144-total;if(remaining>0){chunks.push(chunk.subarray(0,remaining));total+=Math.min(chunk.length,remaining);}if(total>=262144){finish();response.destroy();}});
      response.on("end",finish);response.on("error",reject);
    });
    request.on("error",reject);request.end();
  });
}

/** Every redirect is checked and pinned; private access remains forbidden regardless of table-runner settings. */
export async function fetchPublicBusinessPage(input: string): Promise<{ url: string; text: string }> {
  let url = normalizeWebsite(input);
  const signal=AbortSignal.timeout(15000);
  for (let hop = 0; hop <= 3; hop++) {
    const response = await publicPageRequest(url,signal);
    if (response.status >= 300 && response.status < 400) {
      const location = response.location;
      if (!location || hop === 3) throw new Error("会社サイトの転送が多すぎます。最終URLを入力してください。");
      url = normalizeWebsite(new URL(location, url).href);
      continue;
    }
    if (response.status<200 || response.status>=300) throw new Error(`会社サイトを取得できませんでした（${response.status}）。事業説明を入力して続けられます。`);
    const contentType = response.contentType;
    if (!/text\/(html|plain)|application\/xhtml\+xml/i.test(contentType)) throw new Error("会社URLにはHTMLページを指定してください。");
    const text = websiteText(response.body);
    if (text.length < 80) throw new Error("会社サイトから十分な説明を取得できません。事業内容を入力してください。");
    return { url: url.href, text };
  }
  throw new Error("会社サイトを取得できませんでした。");
}

export function simulatedBusinessAnalysis(input: BusinessAnalysisInput): BusinessAnalysis {
  const label = input.website ? normalizeWebsite(input.website).hostname.replace(/^www\./, "") : "ご入力の事業";
  const business = input.business?.trim() || `${label}のB2Bサービス（シミュレーション。実際のサイト解析は行っていません）`;
  const customer = input.customer?.trim() || "業務の効率化や新規顧客の開拓を検討している企業の経営者・事業責任者";
  const geo = input.geo?.trim() || "日本";
  return { business, customer, geo, summary: `${business}の営業企画例です。見込み客データの検索はまだ接続されていません。`,
    sources: [], segments: ["経営者・事業責任者", "営業部門の責任者", "事業開発の担当者"].map(name => ({
      name, valueProposition: "事業の課題に合う提供価値を確認する", painPoints: "現状の課題は初回の会話で確認する",
      roles: [name], locations: [geo], companySizes: ["要確認"], includeCriteria: customer,
      excludeCriteria: "配信停止を希望された方、事業と関連のない企業", emailInstructions: "日本語で簡潔に提案し、情報交換への関心を確認する",
    })) };
}

export async function analyzeBusiness(input: BusinessAnalysisInput): Promise<BusinessAnalysis> {
  if (!input.website?.trim() && !input.business?.trim()) throw new Error("会社URLまたは事業内容を入力してください。");
  if (getHiguchiMode() === "simulation") return simulatedBusinessAnalysis(input);
  return runInOrganization(input.organizationId, async () => {
    
    const page = input.website?.trim() ? await fetchPublicBusinessPage(input.website) : null;
    const context = JSON.stringify({ website: page?.url, websiteText: page?.text, business: input.business?.slice(0,8000), customer: input.customer?.slice(0,4000), geo: input.geo?.slice(0,1000) });
    const [system, user] = await Promise.all([getPrompt("higuchi/business-system"), getPrompt("higuchi/business-user", { context })]);
    const answer = await completeWithOpenAi({ organizationId:input.organizationId, systemPrompt: system.text, userPrompt: user.text,
      maxOutputTokens: 4000, jsonSchema: z.toJSONSchema(analysisSchema), schemaName: "report_business_analysis", });
    return { ...analysisSchema.parse(JSON.parse(answer.text)), sources: page ? [page.url] : [] };
  });
}

export type EmailDraftInput = { organizationId: string; business: string; audience: string; instructions: string; lead: { name: string; company: string; role?: string }; stage: "initial" | "followup"; bookingUrl?: string };
const emailSchema = z.object({ subject: z.string().min(1).max(200), body: z.string().min(1).max(5000) });
export async function generateOutreachEmail(input: EmailDraftInput): Promise<z.infer<typeof emailSchema>> {
  if (getHiguchiMode() === "simulation") return { subject: `${input.lead.company}様へのご提案`, body: `${input.lead.name}様\n\n${input.business}\n\n${input.stage === "followup" ? "先日のご案内について、ご関心がございましたらお聞かせください。" : "貴社の取り組みについて、情報交換の機会をいただけますでしょうか。"}\n\nよろしくお願いいたします。` };
  return runInOrganization(input.organizationId, async () => {
    
    const context = JSON.stringify({ ...input, organizationId: undefined });
    const [system,user] = await Promise.all([getPrompt("higuchi/email-system"),getPrompt("higuchi/email-user",{context})]);
    const answer = await completeWithOpenAi({ organizationId:input.organizationId, systemPrompt: system.text, userPrompt: user.text, maxOutputTokens: 1600,
      jsonSchema: z.toJSONSchema(emailSchema), schemaName: "report_email_draft", });
    return emailSchema.parse(JSON.parse(answer.text));
  });
}

export type ReplyDraftInput = { organizationId: string; business: string; bookingUrl: string; messages: Array<{direction:string;body:string}> };
const replySchema = z.object({ status: z.enum(["active","interested","suppressed","review"]), body: z.string().max(5000) });
export async function generateReply(input: ReplyDraftInput): Promise<z.infer<typeof replySchema>> {
  const last = input.messages.filter(m=>m.direction === "inbound").at(-1)?.body ?? "";
  if (/配信停止|送らない|連絡不要|unsubscribe|stop\s+(email|contact)/i.test(last)) return {status:"suppressed",body:""};
  if (/ignore.{0,30}(instructions|prompt)|system\s*prompt|秘密|API.?キー|送信先を変更/i.test(last)) return {status:"review",body:""};
  if (getHiguchiMode() === "simulation") {
    const interested = /興味|詳しく|予約|日程|打合|打ち合|meeting|interested/i.test(last);
    return {status:interested?"interested":"active",body:`ご返信ありがとうございます。${interested && input.bookingUrl ? `こちらのURLからご都合のよい日時をお選びください。\n${input.bookingUrl}` : "いただいた内容を確認し、担当者からご案内いたします。"}`};
  }
  return runInOrganization(input.organizationId, async () => {
    
    const context = JSON.stringify({...input,organizationId:undefined,messages:input.messages.slice(-12).map(m=>({...m,body:m.body.slice(0,8000)}))});
    const [system,user] = await Promise.all([getPrompt("higuchi/reply-system"),getPrompt("higuchi/reply-user",{context})]);
    const answer = await completeWithOpenAi({ organizationId:input.organizationId,systemPrompt:system.text,userPrompt:user.text,maxOutputTokens:1600,
      jsonSchema:z.toJSONSchema(replySchema),schemaName:"report_reply_draft", });
    const reply = replySchema.parse(JSON.parse(answer.text));
    return ["suppressed","review"].includes(reply.status) ? {...reply,body:""} : reply;
  });
}

export function simulatedProviderId(prefix: string, requestId: string): string {
  return `${prefix}_${createHash("sha256").update(requestId).digest("hex").slice(0,24)}`;
}
