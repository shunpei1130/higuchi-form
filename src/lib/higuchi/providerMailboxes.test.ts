import {expect,test} from "bun:test";
import {assignProviderMailbox,sendOutreach,HiguchiSendRefusedError} from "./providerMailboxes";

test("sender assignment requires the authorized mailbox owner's OAuth instead of a claimed address",async()=>{
  await expect(assignProviderMailbox({organizationId:"other-org",emailAddress:"somebody@example.com"})).rejects.toThrow("本人認証");
});
test("preview refuses real delivery before looking up credentials or touching the database",async()=>{
  const previous={HIGUCHI_MODE:process.env.HIGUCHI_MODE,VERCEL_ENV:process.env.VERCEL_ENV,HIGUCHI_SEND_ENABLED:process.env.HIGUCHI_SEND_ENABLED};
  try{
    process.env.HIGUCHI_MODE="live";process.env.VERCEL_ENV="preview";process.env.HIGUCHI_SEND_ENABLED="true";
    await expect(sendOutreach({organizationId:"org",projectId:"project",campaignId:"campaign",messageId:"message",lead:{email:"test@example.com",name:"",company:""},subject:"確認",body:"確認"})).rejects.toBeInstanceOf(HiguchiSendRefusedError);
  }finally{for(const [key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
