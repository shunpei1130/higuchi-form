import { describe, expect, test } from "bun:test";
import { mcp } from "@better-auth/mcp";
import { jwt } from "better-auth/plugins";
import { isolateMcpResourceSeeds } from "./mcpSimulation";

/** Exercise the installed plugin's actual initializer, using a fixture adapter that cannot reach a DB. */
async function probe(mode:string|undefined,allowLegacySeeds=true){
  const plugin=mcp({resource:"http://localhost:3000/api/mcp",loginPage:"/sign-in",consentPage:"/oauth/consent"});
  const init=plugin.init,endpoints=plugin.endpoints,schema=plugin.schema;
  expect(isolateMcpResourceSeeds(plugin,mode,allowLegacySeeds)).toBe(plugin);
  expect(plugin.init).toBe(init);expect(plugin.endpoints).toBe(endpoints);expect(plugin.schema).toBe(schema);
  const calls:string[]=[];
  const jwtPlugin=jwt({disableSettingJwtHeader:true});
  const context={
    options:{baseURL:"http://localhost:3000",plugins:[jwtPlugin,plugin],advanced:{database:{generateId:"uuid"}}},
    baseURL:"http://localhost:3000/api/auth",
    adapter:{id:"fixture",findOne:async()=>{calls.push("findOne");return null;},create:async(input:{data:Record<string,unknown>})=>{calls.push("create");return {id:"fixture-resource",...input.data};}},
    logger:{debug:()=>{},info:()=>{},warn:()=>{},error:()=>{}},
    getPlugin:(id:string)=>[jwtPlugin,plugin].find(p=>p.id===id),
  } as unknown as Parameters<typeof plugin.init>[0];
  await plugin.init(context);
  return {calls,resourceSeeds:plugin.options.resources?.length};
}
describe("MCP startup isolation",()=>{
  test("the product disables legacy startup mutations in live mode",async()=>{expect(await probe("live",false)).toEqual({calls:[],resourceSeeds:0});});
  test("explicit simulation performs no adapter reads or writes",async()=>{expect(await probe("simulation")).toEqual({calls:[],resourceSeeds:0});});
  test("live retains the real resource read-and-create startup path",async()=>{expect(await probe("live")).toEqual({calls:["findOne","create"],resourceSeeds:1});});
  test("missing mode preserves live behavior",async()=>{expect(await probe(undefined)).toEqual({calls:["findOne","create"],resourceSeeds:1});});
});
