import { expect,test } from "bun:test";
import { createWorkspace } from "../state";
import type { Conversation } from "../types";
import { explicitOptOut,latestActionableMessageId,latestReplyText,replyMayBePrepared } from "./inboxRules";
function fixture(){
  const state=createWorkspace("simulation","2026-11-17T00:00:00Z"),lead=state.leads[0],campaign=state.campaigns[0];campaign.status="running";lead.status="replied";
  const thread:Conversation={id:"thread",projectId:lead.projectId,campaignId:campaign.id,leadId:lead.id,subject:"ご相談",unread:true,status:"active",notes:"",autoReplyAt:null,pendingReply:null,messages:[{id:"inbound:real",direction:"inbound",body:"詳しい内容を教えてください。",automatic:false,status:"received",sentAt:state.now}]};state.conversations.push(thread);return {state,thread,lead,campaign};
}
test("quoted unsubscribe history is never treated as a new opt-out",()=>{
  const reply="詳しい料金を教えてください。\n\nOn Tue someone wrote:\n配信停止をお願いします\nhttps://example.com";
  expect(latestReplyText(reply)).toBe("詳しい料金を教えてください。");expect(explicitOptOut(reply)).toBe(false);
  expect(explicitOptOut("ありがとうございます。\n> 配信停止してください")).toBe(false);
  expect(explicitOptOut("配信停止: https://example.com/unsubscribe")).toBe(false);
});
test("explicit Japanese and English stop requests remain effective",()=>{
  for(const body of ["配信停止してください。","今後のご連絡は不要です。","連絡しないでください。","Please stop emailing me","Unsubscribe me"])expect(explicitOptOut(body)).toBe(true);
  expect(explicitOptOut("配信停止について教えてください。")).toBe(false);
});
test("automatic responses do not invalidate an outstanding human reply",()=>{
  const {state,thread}=fixture();thread.messages.push({id:"vacation",direction:"inbound",body:"不在です。",automatic:true,status:"received",sentAt:"2026-11-17T00:01:00Z"});
  expect(latestActionableMessageId(thread)).toBe("inbound:real");expect(replyMayBePrepared(state,thread,"inbound:real")).toBe(true);
});
test("archive, suppression, booking and queued manual replies all fence AI completion",()=>{
  const {state,thread,lead,campaign}=fixture();expect(replyMayBePrepared(state,thread,"inbound:real")).toBe(true);
  campaign.status="archived";expect(replyMayBePrepared(state,thread,"inbound:real")).toBe(false);campaign.status="running";
  state.internal.suppressions.push(lead.email);expect(replyMayBePrepared(state,thread,"inbound:real")).toBe(false);state.internal.suppressions=[];
  lead.status="booked";expect(replyMayBePrepared(state,thread,"inbound:real")).toBe(false);lead.status="replied";
  state.internal.outbox.push({id:"manual",projectId:lead.projectId,campaignId:campaign.id,leadId:lead.id,conversationId:thread.id,subject:"Re",body:"担当者の返信",kind:"reply",status:"reserved",createdAt:state.now,reservationCents:0,prepared:true});
  expect(replyMayBePrepared(state,thread,"inbound:real")).toBe(false);
});
test("late historical inbound never supersedes a newer outbound or another campaign",()=>{
  const {state,thread,lead}=fixture();thread.messages.push({id:"sent-later",direction:"outbound",body:"返信済み",automatic:false,status:"sent",sentAt:"2026-11-17T00:02:00Z"},{id:"old-arrived-late",direction:"inbound",body:"古い返信",automatic:false,status:"received",sentAt:"2026-11-16T23:59:00Z"});
  expect(latestActionableMessageId(thread)).toBe("sent-later");expect(replyMayBePrepared(state,thread,"inbound:real")).toBe(false);
  thread.messages=thread.messages.slice(0,1);lead.campaignId="other-campaign";expect(replyMayBePrepared(state,thread,"inbound:real")).toBe(false);
});
