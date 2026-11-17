import { recordActivity, requireCampaign, requireLead, requireProject, type WorkspaceState } from "./state";
import { confirmEmail } from "./engine";

export type PreparationClaim={id:string;fingerprint:string;business:string;audience:string;instructions:string;lead:{name:string;company:string;role:string};stage:"initial"|"followup";bookingUrl:string};
function brief(state:WorkspaceState,id:string){
  const out=state.internal.outbox.find(o=>o.id===id)!;const campaign=requireCampaign(state,out.campaignId),lead=requireLead(state,out.leadId),project=requireProject(state,out.projectId);
  const conversation=state.conversations.find(t=>t.leadId===lead.id&&t.campaignId===campaign.id);
  const context={savedSubject:campaign.emailSubject,savedBody:campaign.emailBody,targeting:campaign.targeting,geography:project.geography,recipient:{name:lead.name,company:lead.company,role:lead.role,website:lead.website},conversation:conversation?.messages.slice(-10).map(m=>({direction:m.direction,body:m.body}))??[],notes:conversation?.notes??""};
  return {out,campaign,lead,project,context};
}
export function claimDraftPreparation(state:WorkspaceState,messageId?:string):PreparationClaim|null{
  for(const out of state.internal.outbox){
    if(messageId&&out.id!==messageId)continue;
    if(out.status==="preparing"&&out.preparingAt&&new Date(state.now).getTime()-new Date(out.preparingAt).getTime()>300000){out.status="reserved";out.preparingAt=undefined;}
    if(out.status!=="reserved"||out.prepared||out.kind==="reply"||out.retryAt&&new Date(out.retryAt).getTime()>new Date(state.now).getTime())continue;
    const {campaign,lead,project,context}=brief(state,out.id);
    if(!["ready","contacted"].includes(lead.status)){out.status="cancelled";continue;}
    if(campaign.status!=="running"||!state.integrations.ai.connected)continue;
    if((out.prepareAttempts??0)>=3){out.status="failed";continue;}
    out.status="preparing";out.preparingAt=state.now;out.prepareAttempts=(out.prepareAttempts??0)+1;
    return {id:out.id,fingerprint:JSON.stringify(context),business:project.description,audience:campaign.audience,instructions:JSON.stringify(context),lead:{name:lead.name,company:lead.company,role:lead.role},stage:out.kind,bookingUrl:state.settings.bookingUrl};
  }
  return null;
}
export function completeDraftPreparation(state:WorkspaceState,claim:PreparationClaim,draft:{subject:string;body:string}):boolean{
  const out=state.internal.outbox.find(o=>o.id===claim.id);if(!out||out.status!=="preparing")return false;
  const current=brief(state,out.id);
  if(current.campaign.status!=="running"||!["ready","contacted"].includes(current.lead.status)||state.internal.suppressions.includes(current.lead.email)){out.status="cancelled";return false;}
  if(JSON.stringify(current.context)!==claim.fingerprint){out.status="reserved";out.preparingAt=undefined;return false;}
  if(!draft.subject.trim()||/[\r\n]/.test(draft.subject)||!draft.body.trim()||draft.body.length>20000)throw new Error("生成されたメールの形式を確認できませんでした。");
  out.subject=draft.subject;out.body=draft.body;out.prepared=true;out.generatedAt=state.now;out.preparingAt=undefined;out.status="reserved";return true;
}
export function failDraftPreparation(state:WorkspaceState,claim:PreparationClaim,message:string):void{
  const out=state.internal.outbox.find(o=>o.id===claim.id);if(!out||out.status!=="preparing")return;
  out.status=(out.prepareAttempts??0)>=3?"failed":"reserved";out.preparingAt=undefined;out.retryAt=new Date(new Date(state.now).getTime()+300000*(out.prepareAttempts??1)).toISOString();
  recordActivity(state,`個別メールを作成できなかったため、送信・課金は行っていません。${message}`,"warning",out.projectId);
}
export type AcceptedReceipt={providerMessageId:string;providerThreadId?:string;acceptedAt:string;upstreamCampaignId?:string};
/** A provider-accepted receipt can be replayed after a crash without sending or billing twice. */
export function recordAcceptedReceipt(state:WorkspaceState,messageId:string,receipt:AcceptedReceipt):void{
  const out=state.internal.outbox.find(o=>o.id===messageId);if(!out||!["sending","uncertain","sent"].includes(out.status))return;
  const wasUncertain=out.status==="uncertain";
  confirmEmail(state,out,receipt.providerMessageId,receipt.acceptedAt);
  const thread=state.conversations.find(t=>t.leadId===out.leadId&&t.campaignId===out.campaignId);if(thread&&receipt.providerThreadId)thread.providerThreadId=receipt.providerThreadId;
  if(receipt.upstreamCampaignId)requireCampaign(state,out.campaignId).upstreamCampaignId=receipt.upstreamCampaignId;
  if(out.kind!=="reply"&&!state.internal.billingJobs.some(j=>j.id===`usage:${out.id}`))state.internal.billingJobs.push({id:`usage:${out.id}`,kind:"usage",status:"pending",projectId:out.projectId,campaignId:out.campaignId,messageId:out.id,messageKind:out.kind,at:receipt.acceptedAt});
  if(wasUncertain)recordActivity(state,"送信元の受付記録と照合し、送信結果・利用記録を復元しました。再送は行っていません。","success",out.projectId);
}
