import type { Conversation } from "../types";
import type { WorkspaceState } from "../state";

/** Only the newly written portion is actionable; quoted unsubscribe footers are history. */
export function latestReplyText(body:string):string{
  const lines=body.replace(/\r\n/g,"\n").split("\n"),kept:string[]=[];
  for(const line of lines){
    if(/^\s*(?:On .{1,300}wrote:|-{2,}\s*(?:Original Message|元のメッセージ|転送メッセージ)|Begin forwarded message:|From:\s|差出人:\s)/i.test(line))break;
    if(/^\s*>/.test(line))continue;
    kept.push(line);
  }
  return kept.join("\n").trim().slice(0,16_000);
}
export function explicitOptOut(body:string):boolean{
  return latestReplyText(body).split("\n").some(line=>{
    const value=line.trim();
    if(/^(?:配信停止|unsubscribe)\s*[:：]?\s*https?:\/\//i.test(value))return false;
    return /(?:配信|送信)(?:を)?停止(?:して|を|希望|お願い|ください|します|願い|$|[。!！])|(?:今後の)?(?:ご)?連絡(?:は|が)?不要(?:です|と|な|$|[。!！])|連絡しないで|(?:メール|案内)(?:は|が)?不要(?:です|$|[。!！])/i.test(value)||/^(?:please\s+)?(?:unsubscribe(?:\s+me)?|stop\s+(?:emailing|contacting)(?:\s+me)?|remove\s+me(?:\s+from\s+.{0,80})?)[.!\s]*$/i.test(value);
  });
}
export function latestActionableMessageId(thread:Pick<Conversation,"messages">):string|undefined{
  let selected:Conversation["messages"][number]|undefined;
  for(const message of thread.messages){
    if(message.direction==="inbound"&&message.automatic)continue;
    if(!selected||Date.parse(message.sentAt)>=Date.parse(selected.sentAt))selected=message;
  }
  return selected?.id;
}
export function replyMayBePrepared(state:WorkspaceState,thread:Conversation,lastInboundId:string):boolean{
  const lead=state.leads.find(item=>item.id===thread.leadId),campaign=state.campaigns.find(item=>item.id===thread.campaignId);
  if(!lead||!campaign||lead.campaignId!==campaign.id||lead.projectId!==thread.projectId||campaign.status!=="running"||["suppressed","booked"].includes(lead.status)||state.internal.suppressions.includes(lead.email)||thread.status==="suppressed"||thread.status==="booked"||latestActionableMessageId(thread)!==lastInboundId)return false;
  return !state.internal.outbox.some(out=>out.conversationId===thread.id&&out.kind==="reply"&&["reserved","preparing","sending","uncertain"].includes(out.status));
}
