import { expect, test } from "bun:test";
import { runHiguchiCronTasks } from "./cronTasks";

test("cron starts private jobs, one preview recovery and PII cleanup concurrently",async()=>{
  const started:string[]=[];let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const pending=runHiguchiCronTasks({jobs:async()=>{started.push("jobs");await gate;return {processed:2,failed:0};},preview:async()=>{started.push("preview");await gate;return {processed:1,failed:0};},retention:async()=>{started.push("retention");await gate;return {runs:3,sessions:2};}});
  await Promise.resolve();expect(started.sort()).toEqual(["jobs","preview","retention"].sort());release();
  expect(await pending).toEqual({processed:2,failed:0,preview:{processed:1,failed:0},retention:{runs:3,sessions:2},failedTasks:[]});
});
test("a failure never abandons another task or returns provider errors or secrets",async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let cleanupFinished=false,complete=false;
  const pending=runHiguchiCronTasks({jobs:async()=>{throw new Error("private-provider-error-secret");},preview:async()=>{await gate;return {processed:1,failed:0};},retention:async()=>{await gate;cleanupFinished=true;return {runs:1,sessions:1};}}).then(result=>{complete=true;return result;});
  await Promise.resolve();expect(complete).toBe(false);release();const result=await pending;expect(cleanupFinished).toBe(true);expect(result.failedTasks).toEqual(["jobs"]);expect(result.preview?.processed).toBe(1);expect(JSON.stringify(result)).not.toContain("private-provider-error-secret");
});
