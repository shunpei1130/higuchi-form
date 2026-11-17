import {expect,test} from "bun:test";
import {enqueueOwnerNotice} from "./ownerNotifications";
import type {JobsExecutor} from "./store";
const executor={} as JobsExecutor;
test("disabled notices neither look up people nor enqueue messages",async()=>{
  await expect(enqueueOwnerNotice(executor,{organizationId:"tenant",enabled:false,kind:"reply",requestId:"event"},{ownerEmail:async()=>{throw new Error("unexpected lookup");},enqueue:async()=>{throw new Error("unexpected queue");}})).resolves.toBeNull();
});
test("a tenant without a verified owner receives no optional notice",async()=>{
  await expect(enqueueOwnerNotice(executor,{organizationId:"tenant",enabled:true,kind:"billing",requestId:"event"},{ownerEmail:async(_tx,org)=>{expect(org).toBe("tenant");return null;},enqueue:async()=>{throw new Error("unexpected queue");}})).resolves.toBeNull();
});
test("notice replay keeps its stable queue identity and static internal links",async()=>{
  const messages:Array<{to:string;idempotencyKey:string;data:Record<string,unknown>}>=[];
  const dependencies={ownerEmail:async(_tx:JobsExecutor,org:string)=>{expect(org).toBe("tenant-a");return "owner@example.com";},enqueue:async(_tx:JobsExecutor|undefined,input:typeof messages[number])=>{messages.push(input);return "same-queue-id";}};
  for(let i=0;i<2;i++)await enqueueOwnerNotice(executor,{organizationId:"tenant-a",enabled:true,kind:"reply",requestId:"provider-id"},dependencies);
  expect(messages[0].idempotencyKey).toBe(messages[1].idempotencyKey);
  expect(messages[0].to).toBe("owner@example.com");
  expect(messages[0].data.text).toContain("/app/inbox");
  expect(Object.keys(messages[0].data).sort()).toEqual(["subject","text"]);
});
