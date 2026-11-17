import { emailFromHeader, gmailPlainText, singleEmail } from "./contract";
export type GoogleMailThread = {providerThreadId:string;leadEmail:string;campaignId?:string;messageIds?:string[];seenMessageIds?:string[]};
export type GoogleMailInbound = {id:string;email:string;subject:string;body:string;at:string;providerMessageId:string;providerThreadId:string;campaignId?:string;isAutomatic:boolean};
type Json=Record<string,unknown>;
const object=(value:unknown):Json=>value&&typeof value==="object"&&!Array.isArray(value)?value as Json:{};
export function extractGoogleMailThread(known:GoogleMailThread,thread:Json):GoogleMailInbound[]{
  const expected=singleEmail(known.leadEmail),result:GoogleMailInbound[]=[];
  const messages=Array.isArray(thread.messages)?thread.messages.map(object).sort((a,b)=>Number(a.internalDate)-Number(b.internalDate)):[];
  const seen=new Set(known.seenMessageIds??[]);
  const header=(message:Json,name:string)=>{const payload=object(message.payload);return String((Array.isArray(payload.headers)?payload.headers.map(object):[]).find(h=>String(h.name).toLowerCase()===name)?.value??"");};
  // Gmail can merge same-subject messages from different app tenants. Only
  // explicit tenant-owned RFC identities may anchor this conversation.
  const roots=new Set(known.messageIds??[]),parents=new Set(roots);
  if(!roots.size)return result;
  for(const message of messages){
    if(typeof message.id!=="string"||(message.threadId&&message.threadId!==known.providerThreadId)||emailFromHeader(header(message,"from"))!==expected)continue;
    const references=header(message,"references").match(/<[^<>\s]+>/g)??[],inReplyTo=header(message,"in-reply-to").match(/<[^<>\s]+>/g)??[];
    const directParent=inReplyTo.at(-1)??references.at(-1);
    if(!directParent||!parents.has(directParent))continue;
    const recipients=`${header(message,"to")} ${header(message,"cc")}`.toLowerCase();
    if(!/(?:^|[\s<,;])shumpei\.hasegawa@maora\.co\.jp(?=[\s>,;]|$)/.test(recipients))continue;
    const body=gmailPlainText(object(message.payload)),timestamp=Number(message.internalDate);
    if(!body.trim()||!Number.isFinite(timestamp))continue;
    const rfcId=header(message,"message-id");if(/^<[^<>\s]+>$/.test(rfcId))parents.add(rfcId);
    if(seen.has(message.id))continue;
    const auto=header(message,"auto-submitted").toLowerCase();
    result.push({id:message.id,email:expected,subject:header(message,"subject").slice(0,500),body,at:new Date(timestamp).toISOString(),providerMessageId:message.id,providerThreadId:known.providerThreadId,campaignId:known.campaignId,isAutomatic:Boolean(auto&&auto!=="no")||/bulk|list|junk/i.test(header(message,"precedence"))});
  }
  return result;
}
