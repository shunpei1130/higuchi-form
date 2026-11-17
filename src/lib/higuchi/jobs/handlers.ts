import "server-only";
import { mutateLive } from "../store";
import { canReserveEmail, runWorkspaceTick, suppressLead } from "../engine";
import { recordActivity, requireCampaign, requireLead, type WorkspaceState } from "../state";
import { claimDraftPreparation, completeDraftPreparation, failDraftPreparation, recordAcceptedReceipt } from "../delivery";
import { enqueueJob, PermanentJobError, type DurableJob, type JobsExecutor } from "./store";
import { explicitOptOut, latestActionableMessageId, latestReplyText, replyMayBePrepared } from "./inboxRules";
import { enqueueOwnerNotice } from "./ownerNotifications";

/** Persist queue entries in the same transaction as the state which requires them. */
export async function scheduleWorkspaceJobs(state:WorkspaceState,org:string,tx:JobsExecutor):Promise<void>{
  for(const out of state.internal.outbox.slice(-200)){
    if(out.retryAt&&Date.parse(out.retryAt)>Date.now())continue;
    if(out.status==="reserved"||(out.status==="preparing"&&Date.now()-Date.parse(out.preparingAt??state.now)>180000)){
      if(!out.prepared&&!state.integrations.booking.connected)continue;
      await enqueueJob({organizationId:org,kind:out.prepared?"outbox.send":"outbox.prepare",entityId:out.id,idempotencyKey:out.id,coalesce:true},tx);
    }else if(out.status==="uncertain"||(out.status==="sending"&&Date.now()-Date.parse(out.createdAt)>180000)){
      out.status="uncertain";
      await enqueueJob({organizationId:org,kind:"outbox.reconcile",entityId:out.id,idempotencyKey:out.id,coalesce:true},tx);
    }
  }
  for(const entry of state.internal.billingJobs){
    if(entry.status==="pending"||(entry.status==="running"&&Date.now()-Date.parse(entry.lockedAt??state.now)>180000)){
      if(entry.retryAt&&Date.parse(entry.retryAt)>Date.now())continue;
      await enqueueJob({organizationId:org,kind:"billing.apply",entityId:entry.id,idempotencyKey:entry.id,coalesce:true},tx);
    }
  }
}

async function plan(org:string){
  const {getIntegrationStates}=await import("../integrations");const statuses=await getIntegrationStates(org);
  await mutateLive(async(state,tx)=>{
    const previous=new Map(state.campaigns.map(campaign=>[campaign.id,campaign.status]));
    state.integrations=statuses;runWorkspaceTick(state);
    for(const campaign of state.campaigns)if(previous.has(campaign.id)&&previous.get(campaign.id)!==campaign.status)await enqueueOwnerNotice(tx,{organizationId:org,enabled:state.settings.emailNotifications,kind:"campaign",requestId:`${campaign.id}:${campaign.status}:${state.activity[0]?.id??state.now}`});
    await scheduleWorkspaceJobs(state,org,tx);
  });
}

async function prepare(org:string,messageId:string){
  const result=await mutateLive(state=>claimDraftPreparation(state,messageId));const claim=result.result;if(!claim)return;
  const out=result.state.internal.outbox.find(o=>o.id===messageId)!;
  try{
    // Host lock must precede workspace lock, so invitations are created outside mutateLive.
    const {getInvitationURL}=await import("../booking/service");
    const invite=await getInvitationURL({organizationId:org,projectId:out.projectId,campaignId:out.campaignId,leadId:out.leadId});
    const {generateOutreachEmail}=await import("../analysis");
    const draft=await generateOutreachEmail({...claim,organizationId:org,bookingUrl:invite.url});
    await mutateLive(async(state,tx)=>{if(completeDraftPreparation(state,claim,draft))await enqueueJob({organizationId:org,kind:"outbox.send",entityId:messageId,idempotencyKey:messageId,coalesce:true},tx);});
  }catch(error){await mutateLive(state=>failDraftPreparation(state,claim,error instanceof Error?error.message:"作成に失敗しました。"));throw error;}
}

async function send(org:string,messageId:string){
  const claimed=await mutateLive(state=>{
    const out=state.internal.outbox.find(o=>o.id===messageId);
    if(!out||out.status!=="reserved"||!out.prepared||(out.retryAt&&Date.parse(out.retryAt)>Date.now()))return null;
    const c=requireCampaign(state,out.campaignId),lead=requireLead(state,out.leadId);
    if(c.status!=="running"||lead.status==="suppressed"||state.internal.suppressions.includes(lead.email)||out.kind!=="reply"&&!["ready","contacted"].includes(lead.status)){out.status="cancelled";return null;}
    if(!state.integrations.email.connected||!state.billing.billingConfigured||state.billing.reconciliationRequired)return null;
    out.status="cancelled";const allowed=canReserveEmail(state,c,out.reservationCents);out.status="reserved";if(!allowed)return null;
    const thread=out.conversationId?state.conversations.find(t=>t.id===out.conversationId&&t.leadId===lead.id&&t.campaignId===c.id):state.conversations.find(t=>t.leadId===lead.id&&t.campaignId===c.id);
    if(out.kind==="reply"&&!thread?.providerThreadId){out.status="failed";recordActivity(state,"返信先の会話を特定できないため、送信を保留しました。","warning",out.projectId);return null;}
    if(thread&&out.kind!=="initial")out.subject=thread.subject;
    out.createdAt=state.now;out.status="sending";
    return {out:structuredClone(out),lead:structuredClone(lead),providerThreadId:thread?.providerThreadId,lastOutboundId:thread?.messages.filter(m=>m.direction==="outbound").at(-1)?.id};
  });
  if(!claimed.result)return;const {out,lead,providerThreadId,lastOutboundId}=claimed.result;
  try{
    const [{sendOutreach},{googleMailMessageId}]=await Promise.all([import("../providerMailboxes"),import("../mail/contract")]);
    const receipt=await sendOutreach({organizationId:org,projectId:out.projectId,campaignId:out.campaignId,messageId:out.id,lead,subject:out.subject,body:out.body,providerThreadId,replyToMessageId:lastOutboundId?googleMailMessageId(org,lastOutboundId):undefined});
    await mutateLive(async(state,tx)=>{recordAcceptedReceipt(state,out.id,receipt);await scheduleWorkspaceJobs(state,org,tx);});
  }catch(error){
    const safe=(error as {uncertain?:boolean}).uncertain===false,retry=safe&&(error as {retryable?:boolean}).retryable!==false;
    await mutateLive(state=>{
      const current=state.internal.outbox.find(o=>o.id===out.id);if(current?.status==="sending"){current.status=retry?"reserved":safe?"failed":"uncertain";if(retry)current.retryAt=new Date(Date.now()+300000).toISOString();}
      if(safe&&error instanceof Error&&error.message.includes("配信停止"))suppressLead(state,requireLead(state,out.leadId));
      recordActivity(state,retry?"送信条件を満たしていないため、5分後に再確認します。":safe?"メールを送信できないため停止しました。":"送信結果を照合中です。重複送信を防ぐため自動再送を止めています。","warning",out.projectId);
    });
    // The planner retries only a refusal known to have happened before acceptance.
  }
}

async function reconcile(org:string,messageId:string){
  const {lookupOutreachDelivery}=await import("../providerMailboxes");const receipt=await lookupOutreachDelivery({organizationId:org,messageId});
  if(receipt.status==="sent"&&receipt.providerMessageId&&receipt.acceptedAt)await mutateLive(async(state,tx)=>{recordAcceptedReceipt(state,messageId,{providerMessageId:receipt.providerMessageId!,providerThreadId:receipt.providerThreadId,acceptedAt:receipt.acceptedAt!});await scheduleWorkspaceJobs(state,org,tx);});
}

async function inbox(org:string){
  const {syncProviderInbox}=await import("../providerMailboxes");const replies=await syncProviderInbox(org);
  for(const incoming of replies)await mutateLive(async(state,tx)=>{
    const key=`inbound:${incoming.providerMessageId}`;if(state.internal.providerEvents.includes(key))return;
    const matches=state.leads.filter(l=>l.email===incoming.email.toLowerCase()&&l.campaignId===incoming.campaignId&&state.conversations.some(t=>t.leadId===l.id&&t.providerThreadId===incoming.providerThreadId));
    if(matches.length!==1)return;
    const lead=matches[0],campaign=requireCampaign(state,lead.campaignId!),thread=state.conversations.find(t=>t.leadId===lead.id&&t.campaignId===campaign.id&&t.providerThreadId===incoming.providerThreadId)!;
    state.internal.providerEvents.push(key);
    thread.messages.push({id:key,direction:"inbound",body:incoming.body,sentAt:incoming.at,automatic:incoming.isAutomatic,status:"received"});thread.unread=true;
    if(incoming.isAutomatic)return;
    await enqueueOwnerNotice(tx,{organizationId:org,enabled:state.settings.emailNotifications,kind:"reply",requestId:key});
    campaign.replyCount++;
    if(explicitOptOut(incoming.body)){suppressLead(state,lead);return;}
    if(latestActionableMessageId(thread)!==key)return;
    lead.nextFollowUpAt=null;thread.autoReplyAt=null;thread.pendingReply=null;
    for(const out of state.internal.outbox)if(out.leadId===lead.id&&["reserved","preparing"].includes(out.status))out.status="cancelled";
    if(lead.status==="suppressed"||lead.status==="booked"||state.internal.suppressions.includes(lead.email)||campaign.status!=="running")return;
    lead.status="replied";
    await enqueueJob({organizationId:org,kind:"reply.prepare",entityId:thread.id,idempotencyKey:key,payload:{lastInboundId:key}},tx);
  });
}

async function reply(org:string,threadId:string,lastInboundId:string){
  const data=await mutateLive(state=>{
    const thread=state.conversations.find(t=>t.id===threadId);if(!thread||!replyMayBePrepared(state,thread,lastInboundId))return null;
    const lead=requireLead(state,thread.leadId);
    return {thread:structuredClone(thread),lead:structuredClone(lead),business:state.projects.find(p=>p.id===lead.projectId)!.description};
  });
  if(!data.result)return;const {thread,lead,business}=data.result;
  const {getInvitationURL}=await import("../booking/service");const invite=await getInvitationURL({organizationId:org,projectId:lead.projectId,campaignId:thread.campaignId,leadId:lead.id});
  const {generateReply}=await import("../analysis");const draft=await generateReply({organizationId:org,business,bookingUrl:invite.url,messages:thread.messages.filter(m=>m.direction!=="inbound"||!m.automatic).sort((a,b)=>Date.parse(a.sentAt)-Date.parse(b.sentAt)).map(m=>({...m,body:m.direction==="inbound"?latestReplyText(m.body):m.body}))});
  await mutateLive(state=>{
    const current=state.conversations.find(t=>t.id===threadId);if(!current||!replyMayBePrepared(state,current,lastInboundId))return;
    const lead=requireLead(state,current.leadId);
    if(draft.status==="suppressed"){suppressLead(state,lead);return;}
    if(draft.status==="review"||!draft.body.trim()){recordActivity(state,"返信内容の確認が必要です。受信トレイを確認してください。","warning",lead.projectId);return;}
    current.status=draft.status;lead.status=draft.status==="interested"?"interested":"replied";current.pendingReply=draft.body;
    current.autoReplyAt=new Date(Date.now()+requireCampaign(state,current.campaignId).replyDelayMinutes*60000).toISOString();
  });
}

async function business(org:string,projectId:string){
  const selected=await mutateLive(state=>structuredClone(state.projects.find(p=>p.id===projectId)));const project=selected.result;if(!project||project.status!=="analyzing")return;
  try{
    const {analyzeBusiness}=await import("../analysis");const result=await analyzeBusiness({organizationId:org,website:project.website,business:project.description,customer:project.icp,geo:project.geography});
    await mutateLive(state=>{const p=state.projects.find(p=>p.id===projectId);if(!p||p.status!=="analyzing")return;p.description=result.business;p.icp=result.customer;p.geography=result.geo||p.geography;p.segments=result.segments;p.analysisSources=result.sources;p.status="ready";recordActivity(state,"会社情報を分析し、対象顧客を整理しました。","success",p.id);});
  }catch(error){await mutateLive(state=>recordActivity(state,"会社情報を分析できませんでした。接続を確認して再試行します。","warning",projectId));throw error;}
}

async function billing(org:string,entryId:string){
  const {claimBillingEntry,completeBillingEntry,failBillingEntry}=await import("./billingTransitions");
  const claimed=await mutateLive(state=>claimBillingEntry(state,entryId));
  const entry=claimed.result;if(!entry)return;
  if(entry.kind==="configure"&&claimed.state.billing.reconciliationRequired){
    await mutateLive(state=>failBillingEntry(state,entry,true));
    throw new PermanentJobError("残高の照合が完了するまで従量課金を再開できません。");
  }
  try{
    const api=await import("../providerBilling");
    let subscriptionId:string|undefined;
    if(entry.kind==="trial")await api.activateBillingTrial({organizationId:org,requestId:entry.id,at:entry.at});
    else if(entry.kind==="topup")await api.grantBillingTopup({organizationId:org,amountCents:entry.amountCents!,creditCents:entry.creditCents!,requestId:entry.id,at:entry.at});
    else if(entry.kind==="configure"){
      await api.configurePostpaidBilling({organizationId:org,requestId:entry.id});
      const {getBillingCredentials}=await import("../billingCredentials");subscriptionId=(await getBillingCredentials(org))?.stripeSubscriptionId;
    }
    else await api.sendUsageEvent({organizationId:org,messageId:entry.messageId!,projectId:entry.projectId!,campaignId:entry.campaignId!,at:entry.at,kind:entry.messageKind!,firstAttemptAt:entry.firstAttemptAt});
    await mutateLive(async(state,tx)=>{const ready=state.billing.billingConfigured;if(completeBillingEntry(state,entry,subscriptionId)&&(!ready&&state.billing.billingConfigured||entry.kind==="topup"))await enqueueOwnerNotice(tx,{organizationId:org,enabled:state.settings.emailNotifications,kind:"billing",requestId:`completed:${entry.id}`});});
  }catch(error){
    const permanent=(error as {reconciliationRequired?:boolean}|null)?.reconciliationRequired===true;
    const failed=await mutateLive(state=>failBillingEntry(state,entry,permanent));
    if(!failed.result)return; // A stale worker cannot reopen an already completed or newly leased entry.
    if(permanent)throw new PermanentJobError("課金結果の照合が必要です。");throw error;
  }
}

export async function handleWorkspaceJob(job:DurableJob):Promise<void>{
  const org=job.organizationId;if(!org)throw new PermanentJobError("組織がありません。");
  const entity=job.entityId??"";
  switch(job.kind){
    case "workspace.plan":return plan(org);
    case "business.analyze":return business(org,entity);
    case "outbox.prepare":return prepare(org,entity);
    case "outbox.send":return send(org,entity);
    case "outbox.reconcile":return reconcile(org,entity);
    case "inbox.sync":return inbox(org);
    case "reply.prepare":return reply(org,entity,String(job.payload.lastInboundId??""));
    case "billing.apply":return billing(org,entity);
    default:throw new PermanentJobError("未対応の処理です。");
  }
}
