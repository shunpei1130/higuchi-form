import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { members, users } from "@/lib/auth/schema";
import { enqueueNotification } from "../notifications";
import type { JobsExecutor } from "./store";

export type OwnerNoticeKind="reply"|"billing"|"campaign";
const copy={
  reply:{subject:"higuchi-form: 返信を受信しました",text:"営業メールへの返信を受信しました。受信箱で内容を確認してください。",path:"/app/inbox"},
  billing:{subject:"higuchi-form: 決済の状況が更新されました",text:"カード・入金・利用料金の処理状況が更新されました。利用状況・請求で確認してください。",path:"/app/billing"},
  campaign:{subject:"higuchi-form: キャンペーンの状態が変わりました",text:"営業キャンペーンの状態が変わりました。キャンペーン一覧で確認してください。",path:"/app/campaigns"},
} as const;
async function ownerEmail(executor:JobsExecutor,organizationId:string):Promise<string|null>{
  const [owner]=await executor.select({email:users.email}).from(members).innerJoin(users,eq(users.id,members.userId)).where(and(eq(members.organizationId,organizationId),eq(users.emailVerified,true),sql`${members.role} ~ '(^|,)[[:space:]]*owner[[:space:]]*(,|$)'`)).orderBy(users.email).limit(1);
  return owner?.email??null;
}
/** Optional notices go only to a verified owner of this tenant, never to prospects. */
export async function enqueueOwnerNotice(executor:JobsExecutor,input:{organizationId:string;enabled:boolean;kind:OwnerNoticeKind;requestId:string},dependencies:{ownerEmail?:typeof ownerEmail;enqueue?:typeof enqueueNotification}={}):Promise<string|null>{
  if(!input.enabled)return null;
  const to=await (dependencies.ownerEmail??ownerEmail)(executor,input.organizationId);if(!to)return null;
  const message=copy[input.kind];
  return (dependencies.enqueue??enqueueNotification)(executor,{organizationId:input.organizationId,to,kind:input.kind,idempotencyKey:`owner:${input.kind}:${input.requestId}`,data:{subject:message.subject,text:`${message.text}\n${new URL(message.path,process.env.BETTER_AUTH_URL??"https://form-higuchi.vercel.app").href}`}});
}
