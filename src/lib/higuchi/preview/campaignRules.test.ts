import { expect, test } from "bun:test";
import { applyPreviewEdit, parsePatchPreview } from "./rules";
import { emptyPreviewState } from "./types";

const parse=(campaign:Record<string,unknown>)=>parsePatchPreview({revision:2,action:{type:"edit_campaign",campaignId:"c",campaign}});
test("campaign edits persist validated search keywords and numeric company sizes",()=>{
  const parsed=parse({audience:"イベント制作会社",searchTerms:[" イベント制作 ","event production","イベント制作"],companySizes:["10-100","100+","100+"]});
  const state=emptyPreviewState();state.campaigns=[{id:"c",name:"campaign",description:"説明",audience:"古い顧客像",roles:[],locations:[],companySizes:[],searchTerms:["旧条件"],valueProposition:"",painPoints:"",includeCriteria:"",excludeCriteria:"",emailInstructions:"",estimatedLeads:null}];
  if(parsed.action.type==="edit_campaign")applyPreviewEdit(state,parsed.action);expect(state.campaigns[0]).toMatchObject({audience:"イベント制作会社",searchTerms:["イベント制作","event production"],companySizes:["10-100","100+"]});expect(parse({companySizes:[]}).action.type).toBe("edit_campaign");
});
test("campaign keywords reject empty, too many, wrong-type, control and out-of-range values",()=>{
  for(const searchTerms of [[],Array.from({length:9},(_,i)=>`term${i}`),["x"],["x".repeat(61)],["valid",null],["bad\nvalue"]])expect(()=>parse({searchTerms})).toThrow();
});
test("campaign employee sizes reject malformed, inverted, unsafe and excessive ranges",()=>{
  for(const companySizes of [["大企業"],["100-10"],["-10"],["10-"],["2000000001"],Array.from({length:6},()=>"10-100"),[5]])expect(()=>parse({companySizes})).toThrow();
});
