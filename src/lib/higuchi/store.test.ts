import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { atomicReplace, mutateSimulation, resolveSimulationSession } from "./store";
import { applyAction, runWorkspaceTick } from "./engine";
import { higuchiMode } from "./mode";

const previousDirectory=process.env.HIGUCHI_SIMULATION_DIRECTORY,previousMode=process.env.HIGUCHI_MODE;
const directory=path.resolve(process.cwd(),".cache",`higuchi-test-${randomUUID()}`);process.env.HIGUCHI_SIMULATION_DIRECTORY=directory;process.env.HIGUCHI_MODE="simulation";
afterAll(async()=>{if(previousDirectory===undefined)delete process.env.HIGUCHI_SIMULATION_DIRECTORY;else process.env.HIGUCHI_SIMULATION_DIRECTORY=previousDirectory;if(previousMode===undefined)delete process.env.HIGUCHI_MODE;else process.env.HIGUCHI_MODE=previousMode;if(directory.startsWith(path.resolve(process.cwd(),".cache")+path.sep))await rm(directory,{recursive:true,force:true});});
describe("durable isolated simulation storage",()=>{
  test("atomic replace retries only transient Windows sharing errors without removing destination",async()=>{
    const codes=["EPERM","EACCES","EBUSY"],delays:number[]=[];let calls=0;let destination="old-valid-json";
    await atomicReplace("pending.tmp","workspace.json",{rename:async(source,target)=>{expect(source).toBe("pending.tmp");expect(target).toBe("workspace.json");expect(destination).toBe("old-valid-json");const code=codes[calls++];if(code)throw Object.assign(new Error("sharing violation"),{code});destination="new-valid-json";},wait:async(delay)=>{delays.push(delay);}});
    expect(calls).toBe(4);expect(delays).toEqual([25,50,100]);expect(destination).toBe("new-valid-json");
  });
  test("atomic replace has bounded retries and preserves the original error",async()=>{
    const error=Object.assign(new Error("locked"),{code:"EPERM"});let calls=0;const delays:number[]=[];
    await expect(atomicReplace("pending.tmp","workspace.json",{rename:async()=>{calls++;throw error;},wait:async(delay)=>{delays.push(delay);}})).rejects.toBe(error);
    expect(calls).toBe(10);expect(delays).toHaveLength(9);expect(Math.max(...delays)).toBe(250);
    let permanentCalls=0;const missing=Object.assign(new Error("missing source"),{code:"ENOENT"});
    await expect(atomicReplace("missing.tmp","workspace.json",{rename:async()=>{permanentCalls++;throw missing;},wait:async()=>{throw new Error("must not retry");}})).rejects.toBe(missing);expect(permanentCalls).toBe(1);
  });
  test("missing mode stays live; simulation rejects nonlocal URLs",async()=>{
    expect(higuchiMode({})).toBe("live");expect(higuchiMode({NODE_ENV:"production"})).toBe("live");
    await expect(resolveSimulationSession(new Request("https://example.com/api/higuchi/workspace"))).rejects.toThrow("ローカル");
  });
  test("session cookie is signed, HttpOnly and isolated",async()=>{
    const a=await resolveSimulationSession(new Request("http://localhost:3000/api/higuchi/workspace"));expect(a.cookie).toContain("HttpOnly");
    const same=await resolveSimulationSession(new Request("http://localhost:3000/api/higuchi/workspace",{headers:{cookie:a.cookie!.split(";")[0]}}));expect(same.id).toBe(a.id);
    const forged=await resolveSimulationSession(new Request("http://localhost:3000/api/higuchi/workspace",{headers:{cookie:a.cookie!.split(";")[0]+"0"}}));expect(forged.id).not.toBe(a.id);
    const b=await resolveSimulationSession(new Request("http://localhost:3000/api/higuchi/workspace"));
    await mutateSimulation(a.id,s=>{s.settings.companyName="Alpha";});const other=await mutateSimulation(b.id,s=>s.settings.companyName);expect(other.result).toBe("");
  });
  test("parallel mutations serialize budget reservations without duplicate sends",async()=>{
    const session=randomUUID();const now=new Date("2026-11-16T01:00:00Z");await mutateSimulation(session,s=>{applyAction(s,{type:"billing.verify",requestId:"one"});s.projects[0].dailyBudgetCents=4;s.campaigns[0].status="running";},now);
    await Promise.all(Array.from({length:12},()=>mutateSimulation(session,s=>{runWorkspaceTick(s);},now)));
    const saved=await mutateSimulation(session,s=>({balance:s.billing.balanceCents,sends:s.campaigns[0].sentCount}),now);expect(saved.result).toEqual({balance:2996,sends:1});
  });
  test("failed mutation rolls back whole file state",async()=>{
    const session=randomUUID();await mutateSimulation(session,()=>{});await expect(mutateSimulation(session,s=>{s.billing.balanceCents=999;throw new Error("abort");})).rejects.toThrow("abort");
    const saved=await mutateSimulation(session,s=>s.billing.balanceCents);expect(saved.result).toBe(0);
  });
});
