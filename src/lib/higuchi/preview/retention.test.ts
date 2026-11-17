import { expect, test } from "bun:test";
import { expiredPreviewPatch, expiredPreviewTokenHash, PREVIEW_SCRUBBED_CODE } from "./retentionPolicy";
import { emptyPreviewState } from "./types";

test("expired preview scrub removes company, contacts, draft and error content without changing retained identities",()=>{
  const original={id:"run-id",sessionId:"session-id",status:"running" as const,revision:3,generation:7,claimedOrganizationId:"org-id",claimedProjectId:"project-id",input:{website:"https://private-business.jp",business:"business secret"},state:emptyPreviewState(),errorMessage:"private-address@company.jp",lockedBy:"provider-owner"};
  original.state.company={name:"Private Company",website:"https://private-business.jp",business:"business secret",customer:"customer secret",geography:"日本",summary:"private summary",sources:[]};
  const patch=expiredPreviewPatch(original,new Date("2026-11-18T00:00:00Z"));const result={...original,...patch};
  expect(result.id).toBe(original.id);expect(result.sessionId).toBe(original.sessionId);expect(result.claimedOrganizationId).toBe(original.claimedOrganizationId);expect(result.claimedProjectId).toBe(original.claimedProjectId);
  expect(result).toMatchObject({status:"failed",revision:4,generation:8,lockedBy:null,leaseUntil:null,errorCode:PREVIEW_SCRUBBED_CODE,errorMessage:null,errorRetryable:0});
  expect(JSON.stringify(patch)).not.toContain("business secret");expect(JSON.stringify(patch)).not.toContain("private-address");expect(result.state.company).toBeNull();expect(result.state.candidates).toHaveLength(0);expect(result.state.drafts).toHaveLength(0);expect(Object.values(result.input).every(value=>value==="")).toBe(true);
  expect(original.state.company.name).toBe("Private Company");expect(Object.keys(patch)).not.toContain("usage");expect(Object.keys(patch)).not.toContain("claimedProjectId");
});
test("claimed runs preserve their audit state and expired sessions invalidate only the old cookie hash",()=>{
  expect(expiredPreviewPatch({status:"claimed",revision:4,generation:1},new Date()).status).toBe("claimed");expect(expiredPreviewTokenHash("one")).toBe("expired:one");expect(expiredPreviewTokenHash("one")).not.toBe(expiredPreviewTokenHash("two"));
});
