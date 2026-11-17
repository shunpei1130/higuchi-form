import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { buildGoogleMail, gmailPlainText, GOOGLE_MAIL_SENDER, googleMailMessageId, signMailState, verifyMailState } from "./contract";
import { extractGoogleMailThread } from "./thread";
import { decryptNotification, encryptNotification, notificationEnvelope, notificationKey, NOTIFICATION_FROM, NOTIFICATION_REPLY_TO, renderNotification, verifyResendSignature } from "./notificationsContract";
import { deliverNotification } from "./notificationDelivery";

const org="11111111-1111-4111-8111-111111111111",otherOrg="22222222-2222-4222-8222-222222222222",now=Date.parse("2026-11-17T00:00:00Z"),secret="test-only-credential-key";
const original={mode:process.env.HIGUCHI_MODE,key:process.env.INTEGRATION_CREDENTIALS_KEY,resend:process.env.RESEND_API_KEY};
beforeEach(()=>{process.env.HIGUCHI_MODE="live";process.env.INTEGRATION_CREDENTIALS_KEY=secret;process.env.RESEND_API_KEY="re_test_fake_never_sent";});
afterEach(()=>{for(const [key,value]of Object.entries({HIGUCHI_MODE:original.mode,INTEGRATION_CREDENTIALS_KEY:original.key,RESEND_API_KEY:original.resend})){if(value===undefined)delete process.env[key];else process.env[key]=value;}});

describe("Google mail OAuth and identity",()=>{
  const state={organizationId:org,userId:"operator-a",nonce:"n".repeat(43),expiresAt:now+600_000};
  test("state binds operator, organization, expiry and signature",()=>{
    const signed=signMailState(state,secret);expect(verifyMailState(signed,"operator-a",secret,now)).toEqual(state);
    expect(()=>verifyMailState(signed,"operator-b",secret,now)).toThrow();
    expect(()=>verifyMailState(signed,"operator-a",secret,now+600_001)).toThrow();
    expect(()=>verifyMailState(signed.slice(0,-4)+"fake","operator-a",secret,now)).toThrow();
    expect(()=>verifyMailState(signed,"operator-a","different-secret",now)).toThrow();
  });
  test("RFC message identity is stable and tenant-separated",()=>{
    expect(googleMailMessageId(org,"message-a")).toBe(googleMailMessageId(org,"message-a"));
    expect(googleMailMessageId(org,"message-a")).not.toBe(googleMailMessageId(otherOrg,"message-a"));
    expect(googleMailMessageId(org,"message-a")).not.toContain(org);
  });
  test("MIME pins sender and rejects header injection",()=>{
    const input={organizationId:org,messageId:"message-a",to:"lead@example.com",subject:"ご相談",body:"本文です。"};
    const mail=buildGoogleMail(input),raw=Buffer.from(mail.raw,"base64url").toString("utf8");
    expect(raw).toContain(`From: higuchi-form <${GOOGLE_MAIL_SENDER}>`);expect(raw).toContain(`Message-ID: ${mail.rfcMessageId}`);
    expect(()=>buildGoogleMail({...input,to:"lead@example.com\r\nBcc: other@example.com"})).toThrow();
    expect(()=>buildGoogleMail({...input,subject:"hello\r\nBcc: other@example.com"})).toThrow();
    expect(()=>buildGoogleMail({...input,unsubscribeUrl:"javascript:alert(1)"})).toThrow();
  });
});

const rootId=googleMailMessageId(org,"original"),known={providerThreadId:"thread1",leadEmail:"lead@example.com",campaignId:"campaign1",messageIds:[rootId]};
function message(id:string,headers:Record<string,string>={}){return {id,threadId:"thread1",internalDate:String(now),payload:{mimeType:"text/plain",headers:Object.entries({From:"Lead <lead@example.com>",To:GOOGLE_MAIL_SENDER,Subject:"Re: ご相談",References:rootId,...headers}).map(([name,value])=>({name,value})),body:{data:Buffer.from("返信です").toString("base64url"),size:12}}};}
describe("product-thread inbox boundary",()=>{
  test("imports only a known recipient's anchored reply",()=>{
    const found=extractGoogleMailThread(known,{messages:[message("valid"),message("unrelated",{References:"<other@company.example>"}),message("other-sender",{From:"other@example.com"}),message("wrong-recipient",{To:`evil${GOOGLE_MAIL_SENDER}.example`})]});
    expect(found.map(item=>item.providerMessageId)).toEqual(["valid"]);expect(found[0].campaignId).toBe("campaign1");
  });
  test("cannot use a substring as a trusted reference or a different thread",()=>{
    expect(extractGoogleMailThread(known,{messages:[message("forged",{References:rootId.replace(">",".evil>")}),{...message("wrong-thread"),threadId:"another"}]})).toEqual([]);
  });
  test("a thread with no application root never enters the product",()=>{
    expect(extractGoogleMailThread({...known,messageIds:undefined},{messages:[message("unrelated")]})).toEqual([]);
  });
  test("automatic replies are explicitly marked to prevent loops",()=>{
    const found=extractGoogleMailThread(known,{messages:[message("vacation",{"Auto-Submitted":"auto-replied"})]});expect(found[0].isAutomatic).toBe(true);
  });
  test("seen messages do not hide older unprocessed replies",()=>{
    const found=extractGoogleMailThread({...known,seenMessageIds:["already-read"]},{messages:[message("already-read"),message("unprocessed")]});expect(found.map(item=>item.id)).toEqual(["unprocessed"]);
  });
  test("a merged Gmail thread cannot import another tenant's direct reply",()=>{
    const foreignRoot=googleMailMessageId(otherOrg,"original");
    const found=extractGoogleMailThread(known,{messages:[message("foreign-direct-parent",{References:`${rootId} ${foreignRoot}`,"In-Reply-To":foreignRoot})]});expect(found).toEqual([]);
  });
  test("does not ingest attachments and strips active HTML",()=>{
    expect(gmailPlainText({mimeType:"text/plain",filename:"private.txt",body:{data:Buffer.from("secret").toString("base64url")}})).toBe("");
    const html=gmailPlainText({mimeType:"text/html",body:{data:Buffer.from("<script>steal()</script><p>ご返信</p><img src='tracking'>").toString("base64url")}});
    expect(html).toContain("ご返信");expect(html).not.toContain("steal");expect(html).not.toContain("<img");
  });
});

describe("durable transactional notifications",()=>{
  const auth={to:"user@example.com",kind:"auth" as const,data:{subject:"認証コード",text:"123456",html:"<p>123456</p>"},idempotencyKey:"auth-code-event"};
  test("encrypts recipient and one-time secrets, with short expiration",()=>{
    const envelope=notificationEnvelope(auth,new Date(now)),encrypted=encryptNotification(envelope);
    expect(encrypted).not.toContain("123456");expect(encrypted).not.toContain("user@example.com");expect(decryptNotification(encrypted)).toEqual(envelope);
    expect(Date.parse(envelope.expiresAt)-now).toBe(300_000);expect(notificationKey("user@example.com")).not.toContain("user@example.com");
  });
  test("booking content escapes HTML and rejects an external manage URL",()=>{
    const rendered=renderNotification(notificationEnvelope({to:"guest@example.com",kind:"booking.confirmed",idempotencyKey:"booking1",data:{eventTitle:"<script>bad</script>",startsAt:new Date(now).toISOString(),endsAt:new Date(now+1800_000).toISOString(),timezone:"Asia/Tokyo",locationText:"参加URLは担当者が別途ご案内します",manageUrl:"https://attacker.example/secret"}},new Date(now)));
    expect(rendered.subject).toContain("予約が確定");expect(rendered.html).toContain("&lt;script&gt;");expect(rendered.html).not.toContain("<script>");expect(rendered.text).not.toContain("attacker.example");
    expect(rendered.text).toContain("参加URLは担当者が別途ご案内します");
  });
  test("uses fixed notification identity and the same idempotency key on retry",async()=>{
    const payload=encryptNotification(notificationEnvelope(auth,new Date(now))),requests:Array<RequestInit>=[];
    const fake=(async(_url:unknown,init:RequestInit)=>{requests.push(init);return Response.json({id:"provider-notice"});}) as unknown as typeof fetch;
    await deliverNotification(payload,"stable-job",fake,now);await deliverNotification(payload,"stable-job",fake,now+1000);
    const body=JSON.parse(String(requests[0].body));expect(body.from).toBe(NOTIFICATION_FROM);expect(body.reply_to).toBe(NOTIFICATION_REPLY_TO);
    expect(new Headers(requests[0].headers).get("Idempotency-Key")).toBe(new Headers(requests[1].headers).get("Idempotency-Key"));
  });
  test("expired auth is completed without a provider request",async()=>{
    let called=false;const fake=(async()=>{called=true;return Response.json({id:"never"});}) as unknown as typeof fetch;
    const result=await deliverNotification(encryptNotification(notificationEnvelope(auth,new Date(now))),"expired",fake,now+300_001);
    expect(result.expired).toBe(true);expect(called).toBe(false);
  });
  test("simulation never sends notifications",async()=>{
    process.env.HIGUCHI_MODE="simulation";let called=false;
    const fake=(async()=>{called=true;return Response.json({id:"never"});}) as unknown as typeof fetch;
    await expect(deliverNotification(encryptNotification(notificationEnvelope(auth,new Date(now))),"sim",fake,now)).rejects.toThrow();expect(called).toBe(false);
  });
  test("verifies raw payload, timestamp and rotating Svix signatures",()=>{
    const raw=JSON.stringify({type:"email.delivered",data:{email_id:"notice"}}),key=Buffer.from("test-signing-secret"),timestamp=String(now/1000),id="event1";
    const signature=createHmac("sha256",key).update(`${id}.${timestamp}.${raw}`).digest("base64"),headers=new Headers({"svix-id":id,"svix-timestamp":timestamp,"svix-signature":`v1,invalid v1,${signature}`}),secret=`whsec_${key.toString("base64")}`;
    expect(verifyResendSignature(raw,headers,secret,now).eventId).toBe(id);
    expect(()=>verifyResendSignature(raw+" ",headers,secret,now)).toThrow();expect(()=>verifyResendSignature(raw,headers,secret,now+300_001)).toThrow();
  });
});
