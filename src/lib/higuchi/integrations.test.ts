import {expect,test} from "bun:test";
import {getIntegrationStates} from "./integrations";
import type {ConnectionState} from "./types";
test("simulation readiness does not read provider credentials or query tenant data",async()=>{
  const previous=process.env.HIGUCHI_MODE;process.env.HIGUCHI_MODE="simulation";
  try{let reads=0;const read=async():Promise<ConnectionState>=>{reads++;throw new Error("must not query");};const state=await getIntegrationStates("00000000-0000-0000-0000-000000000001",{ai:read,email:read,booking:read,billing:read});expect(reads).toBe(0);expect(Object.values(state).every(value=>value.status==="simulation")).toBe(true);}
  finally{if(previous===undefined)delete process.env.HIGUCHI_MODE;else process.env.HIGUCHI_MODE=previous;}
});
test("one broken tenant integration fails closed without hiding the other readiness results",async()=>{
  const previous=process.env.HIGUCHI_MODE;process.env.HIGUCHI_MODE="live";
  try{const visited:string[]=[],org="00000000-0000-0000-0000-000000000001";const read=async(id:string):Promise<ConnectionState>=>{visited.push(id);return {connected:true,status:"ready",detail:"接続済み"};};const state=await getIntegrationStates(org,{ai:read,email:read,booking:read,billing:async id=>{visited.push(id);throw new Error("untrusted secret should stay internal");}});expect(visited).toEqual([org,org,org,org]);expect(state.ai.connected).toBe(true);expect(state.email.connected).toBe(true);expect(state.booking.connected).toBe(true);expect(state.billing.connected).toBe(false);expect(state.billing.detail).not.toContain("untrusted");}
  finally{if(previous===undefined)delete process.env.HIGUCHI_MODE;else process.env.HIGUCHI_MODE=previous;}
});
