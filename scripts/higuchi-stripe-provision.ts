/** Explicit operator provisioning. Secrets enter through stdin and remain in process memory only. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BillingCredentials } from "../src/lib/higuchi/billingCredentials";

const SANDBOX_ACCOUNT="acct_1UcblRRGx64luiLk",LIVE_ACCOUNT="acct_1SOtr4EXrauv37Rg";
const PROJECT="prj_Jfz4TuWBMR7mPl59pIaISCCve6JV",TEAM="team_Iic3HLNmnGRA51i7VKtiOMmN";
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const VERSION="2026-10-28.endive";
const EVENTS=["checkout.session.completed","checkout.session.async_payment_succeeded","checkout.session.async_payment_failed","invoice.paid","invoice.payment_failed","invoice.payment_action_required","invoice.voided","invoice.marked_uncollectible","customer.subscription.updated","customer.subscription.deleted","charge.refunded","charge.dispute.created","radar.early_fraud_warning.created"];
type Json=Record<string,unknown>;
type Env={key?:string;value?:string;type?:string;target?:string[];gitBranch?:string|null;comment?:string;id?:string};
const object=(value:unknown):Json=>value&&typeof value==="object"&&!Array.isArray(value)?value as Json:{};
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
class ProvisionError extends Error{constructor(readonly stage:string,readonly code:string,readonly parameter?:string){super(code);}}
function fail(stage:string,code:string,parameter?:string):never{throw new ProvisionError(stage,code,parameter);}

export function parseProvisionArguments(args:string[]):{accountId:string;allowLive:boolean;webhookUrl:string;keyStdin:boolean;catalogOnly:boolean;help:boolean}{
  let accountId="",allowLive=false,webhookUrl="",keyStdin=false,catalogOnly=false,help=false;
  for(let index=0;index<args.length;index++){
    const argument=args[index];
    if(argument==="--help"){help=true;continue;}
    if(argument==="--key-stdin"){keyStdin=true;continue;}
    if(argument==="--allow-live"){allowLive=true;continue;}
    if(argument==="--catalog-only"||argument==="--skip-webhook"){catalogOnly=true;continue;}
    if(argument==="--account-id"||argument==="--webhook-url"){
      const value=args[++index];if(!value||value.startsWith("--"))fail("arguments","MISSING_OPTION_VALUE");
      if(argument==="--account-id")accountId=value;else webhookUrl=value;continue;
    }
    fail("arguments","UNKNOWN_OPTION");
  }
  if(help)return {accountId,allowLive,webhookUrl,keyStdin,catalogOnly,help};
  if(!keyStdin)fail("arguments","KEY_STDIN_REQUIRED");
  if(![SANDBOX_ACCOUNT,LIVE_ACCOUNT].includes(accountId))fail("arguments","UNAPPROVED_ACCOUNT");
  if(accountId===LIVE_ACCOUNT&&!allowLive)fail("arguments","LIVE_REQUIRES_EXPLICIT_FLAG");
  if(catalogOnly)return {accountId,allowLive,webhookUrl:"",keyStdin,catalogOnly,help};
  if(!webhookUrl){if(accountId===LIVE_ACCOUNT)webhookUrl="https://form-higuchi.vercel.app/api/webhooks/stripe";else fail("arguments","SANDBOX_PREVIEW_WEBHOOK_URL_REQUIRED");}
  let url:URL;try{url=new URL(webhookUrl);}catch{fail("arguments","INVALID_WEBHOOK_URL");}
  const projectHost=url.hostname==="form-higuchi.vercel.app"||url.hostname.startsWith("form-higuchi-")&&url.hostname.endsWith(".vercel.app");
  if(url.protocol!=="https:"||url.username||url.password||!projectHost||url.pathname!=="/api/webhooks/stripe"||url.hash)fail("arguments","INVALID_WEBHOOK_URL");
  if(accountId===SANDBOX_ACCOUNT&&url.hostname==="form-higuchi.vercel.app")fail("arguments","SANDBOX_REQUIRES_PREVIEW_URL");
  if(accountId===LIVE_ACCOUNT&&url.href!=="https://form-higuchi.vercel.app/api/webhooks/stripe")fail("arguments","LIVE_REQUIRES_PRODUCTION_URL");
  return {accountId,allowLive,webhookUrl:url.href,keyStdin,catalogOnly,help};
}
export function validateProvisionKey(key:string,accountId:string):boolean{
  if(!/^(?:rk|sk)_(?:test|live)_[A-Za-z0-9]+$/.test(key))fail("stdin","INVALID_KEY_FORMAT");
  const live=/^(?:rk|sk)_live_/.test(key);
  if(live!==(accountId===LIVE_ACCOUNT))fail("stdin","KEY_ACCOUNT_MODE_MISMATCH");return live;
}
async function readKey():Promise<string>{
  if(process.stdin.isTTY)fail("stdin","PIPE_SECRET_WITHOUT_ECHO");
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of process.stdin){const part=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=part.length;if(size>16384)fail("stdin","INPUT_TOO_LARGE");chunks.push(part);}
  return Buffer.concat(chunks).toString("utf8").trim();
}
function vercelApi(path:string,body?:unknown):Json{
  const appData=process.env.APPDATA;if(!appData)fail("vercel","CLI_UNAVAILABLE");
  const cli=join(appData,"npm","node_modules","vercel","dist","vc.js");if(!existsSync(cli))fail("vercel","CLI_UNAVAILABLE");
  const childEnv={...process.env};delete childEnv.STRIPE_SECRET_KEY;delete childEnv.STRIPE_WEBHOOK_SECRET;
  const args=[cli,"api",path,"--raw","--non-interactive",...(body===undefined?[]:["--method","POST","--input","-"])];
  const result=spawnSync("node",args,{cwd:ROOT,env:childEnv,input:body===undefined?undefined:JSON.stringify(body),encoding:"utf8",windowsHide:true,timeout:60000,maxBuffer:5000000});
  // Never emit raw subprocess output: an env-write response may contain the submitted secret.
  if(result.error||result.status!==0)fail("vercel",body===undefined?"READ_FAILED":"ENV_WRITE_FAILED");
  let parsed:Json;try{parsed=object(JSON.parse(result.stdout));}catch{fail("vercel","INVALID_RESPONSE");}
  if(parsed.error)fail("vercel","API_REJECTED_REQUEST");return parsed;
}
function environmentEntries(response:Json,target:string):Env[]{return Array.isArray(response.envs)?response.envs.map(value=>object(value) as Env).filter(value=>value.target?.includes(target)&&!value.gitBranch):[];}
async function main(){
  const options=parseProvisionArguments(process.argv.slice(2));
  if(options.help){console.log("higuchi-stripe-provision --key-stdin --account-id <approved acct> [--catalog-only | --webhook-url <Preview https URL>] [--allow-live]");return;}
  const key=await readKey(),livemode=validateProvisionKey(key,options.accountId),target=livemode?"production":"preview";
  if(!options.catalogOnly&&!key.startsWith("rk_"))fail("stdin","FULL_KEY_MAY_ONLY_PROVISION_CATALOG_IN_MEMORY");
  // Bind the authenticated CLI to the exact application before any remote mutation.
  const envPath=`/v10/projects/${PROJECT}/env?teamId=${TEAM}`;
  let existing:Env[]=[];
  if(!options.catalogOnly){
    let context:Json;try{context=object(JSON.parse(readFileSync(join(ROOT,".vercel","project.json"),"utf8")));}catch{fail("vercel","PROJECT_LINK_REQUIRED");}
    if(context.projectId!==PROJECT||context.orgId!==TEAM)fail("vercel","PROJECT_LINK_MISMATCH");
    const project=vercelApi(`/v9/projects/${PROJECT}?teamId=${TEAM}`);if(project.id!==PROJECT||project.name!=="form-higuchi"||project.accountId!==TEAM)fail("vercel","PROJECT_IDENTITY_MISMATCH");
    existing=environmentEntries(vercelApi(envPath),target);
    const previousAccount=existing.find(value=>value.key==="STRIPE_ACCOUNT_ID");if(previousAccount?.value&&previousAccount.value!==options.accountId)fail("vercel","EXISTING_ACCOUNT_MAPPING_MISMATCH");
  }
  process.env.STRIPE_SECRET_KEY=key;process.env.STRIPE_ACCOUNT_ID=options.accountId;
  process.env.STRIPE_METER_EVENT_NAME="higuchi_email_sent_v1";
  const [{provisionStripeBillingCatalog,stripeForm},{platformBillingCredentials}]=await Promise.all([import("../src/lib/higuchi/providerBilling"),import("../src/lib/higuchi/billingCredentials")]);
  const stripe=async(credentials:BillingCredentials,path:string,body?:Json,requestKey?:string):Promise<Json>=>{
    const response=await fetch(`https://api.stripe.com/v1${path}`,{method:body?"POST":"GET",headers:{Authorization:`Bearer ${credentials.stripeSecretKey}`,"Stripe-Version":VERSION,...(body?{"Content-Type":"application/x-www-form-urlencoded"}:{}),...(requestKey?{"Idempotency-Key":`higuchi-provision-${digest(requestKey)}`}:{})},body:body?stripeForm(body):undefined,cache:"no-store",signal:AbortSignal.timeout(25000)});
    const result=object(await response.json().catch(()=>null));
    if(!response.ok){const error=object(result.error),parameter=typeof error.param==="string"&&/^[a-zA-Z0-9_[\].]{1,100}$/.test(error.param)?error.param:undefined;fail("stripe",`HTTP_${response.status}${typeof error.code==="string"&&/^[a-z0-9_]{1,80}$/.test(error.code)?`_${error.code}`:""}`,parameter);}
    return result;
  };
  const credentials=platformBillingCredentials();
  const account=await stripe(credentials,"/account");if(account.id!==options.accountId)fail("stripe","ACCOUNT_IDENTITY_MISMATCH");
  const catalog=await provisionStripeBillingCatalog({allowLive:options.allowLive},{request:stripe});
  if(options.catalogOnly){console.log(JSON.stringify({status:"catalog_configured",accountId:options.accountId,livemode,target,productId:catalog.productId,meterId:catalog.meterId,priceId:catalog.priceId,eventName:catalog.eventName,webhook:"not_created",environmentRegistration:"not_performed"}));return;}
  const endpoints:Json[]=[];let cursor="";
  for(let page=0;page<100;page++){const result=await stripe(credentials,`/webhook_endpoints?limit=100${cursor?`&starting_after=${encodeURIComponent(cursor)}`:""}`),batch=Array.isArray(result.data)?result.data.map(object):[];endpoints.push(...batch);if(!result.has_more)break;const last=batch.at(-1);if(!last||typeof last.id!=="string")fail("stripe","INVALID_WEBHOOK_PAGINATION");cursor=last.id;if(page===99)fail("stripe","WEBHOOK_LIST_TOO_LARGE");}
  const matched=endpoints.filter(endpoint=>{const m=object(endpoint.metadata);return m.higuchi_app==="higuchi-form"&&m.higuchi_purpose==="billing_global_webhook"&&m.higuchi_environment===target;});
  if(matched.length>1)fail("stripe","DUPLICATE_APP_WEBHOOKS");
  let endpoint=matched[0],webhookSecret:string|undefined;
  if(endpoint){
    if(endpoint.livemode!==livemode||endpoint.api_version!==VERSION||typeof endpoint.id!=="string")fail("stripe","EXISTING_WEBHOOK_CONFIGURATION_MISMATCH");
    const marker=`higuchi-form:${options.accountId}:${endpoint.id}`;
    if(!existing.some(value=>value.key==="STRIPE_WEBHOOK_SECRET"&&value.type==="sensitive"&&value.comment===marker))fail("stripe","EXISTING_WEBHOOK_SECRET_NOT_REGISTERED");
    const enabledEvents=endpoint.enabled_events;
    const sameEvents=Array.isArray(enabledEvents)&&enabledEvents.length===EVENTS.length&&EVENTS.every(event=>enabledEvents.includes(event));
    if(endpoint.url!==options.webhookUrl||endpoint.status!=="enabled"||!sameEvents)endpoint=await stripe(credentials,`/webhook_endpoints/${encodeURIComponent(String(endpoint.id))}`,{url:options.webhookUrl,disabled:false,enabled_events:EVENTS},`webhook-update:${options.accountId}:${target}:${digest(options.webhookUrl)}`);
  }else{
    endpoint=await stripe(credentials,"/webhook_endpoints",{url:options.webhookUrl,api_version:VERSION,enabled_events:EVENTS,description:`higuchi-form ${target} billing`,metadata:{higuchi_app:"higuchi-form",higuchi_purpose:"billing_global_webhook",higuchi_environment:target}},`webhook-create:${options.accountId}:${target}`);
    if(typeof endpoint.secret!=="string"||!endpoint.secret.startsWith("whsec_")||endpoint.livemode!==livemode||typeof endpoint.id!=="string")fail("stripe","WEBHOOK_CREATE_RECEIPT_INVALID");
    webhookSecret=endpoint.secret;
  }
  const fields=[{key:"STRIPE_SECRET_KEY",value:key,type:"sensitive"},{key:"STRIPE_ACCOUNT_ID",value:options.accountId,type:"plain"},{key:"STRIPE_PRODUCT_ID",value:catalog.productId,type:"plain"},{key:"STRIPE_METER_ID",value:catalog.meterId,type:"plain"},{key:"STRIPE_PRICE_ID",value:catalog.priceId,type:"plain"},...(webhookSecret?[{key:"STRIPE_WEBHOOK_SECRET",value:webhookSecret,type:"sensitive"}]:[])].map(field=>({...field,target:[target],gitBranch:null,comment:field.key==="STRIPE_WEBHOOK_SECRET"?`higuchi-form:${options.accountId}:${endpoint.id}`:`higuchi-form:${options.accountId}`}));
  vercelApi(`${envPath}&upsert=true`,fields);
  const confirmed=environmentEntries(vercelApi(envPath),target),expected=["STRIPE_SECRET_KEY","STRIPE_ACCOUNT_ID","STRIPE_PRODUCT_ID","STRIPE_METER_ID","STRIPE_PRICE_ID","STRIPE_WEBHOOK_SECRET"];
  if(!expected.every(name=>confirmed.some(value=>value.key===name&&(name.endsWith("SECRET_KEY")||name.endsWith("WEBHOOK_SECRET")?value.type==="sensitive":value.type==="plain"))))fail("vercel","ENV_REGISTRATION_INCOMPLETE");
  console.log(JSON.stringify({status:"configured",accountId:options.accountId,livemode,target,productId:catalog.productId,meterId:catalog.meterId,priceId:catalog.priceId,webhookId:endpoint.id,registered:expected,redeploymentRequired:true}));
}
if(import.meta.main){try{await main();}catch(error){const safe=error instanceof ProvisionError?error:new ProvisionError("provision","FAILED_WITH_DETAILS_REDACTED");console.error(JSON.stringify({status:"failed",stage:safe.stage,code:safe.code,...(safe.parameter?{parameter:safe.parameter}:{})}));process.exitCode=1;}}
