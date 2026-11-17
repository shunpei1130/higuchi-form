import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { bootstrapPlan, OPERATOR_EMAIL, OPERATOR_ORGANIZATION, OPERATOR_SLUG, type BootstrapSnapshot } from "../../src/lib/auth/operatorBootstrapPolicy";

// Explicit, one-time infrastructure operation. No password or session is
// created and email remains unverified until the operator completes OTP.
const args=new Set(process.argv.slice(2));
if(args.has("--check")){
  if(bootstrapPlan({users:[],organizations:[],members:[]}).status!=="create")throw new Error("Empty bootstrap fixture failed");
  let rejected=false;try{bootstrapPlan({users:[{id:"other",email:"other@example.com"}],organizations:[],members:[]});}catch{rejected=true;}
  if(!rejected)throw new Error("Existing-account bootstrap fixture failed");
  console.log("Operator bootstrap static fixtures passed. No database connection or write was performed.");
}else{
  const apply=args.has("--apply");
  if(apply&&!args.has(`--confirm-operator=${OPERATOR_EMAIL}`))throw new Error("--apply requires the explicit --confirm-operator email confirmation.");
  const allowed=new Set(["--apply",`--confirm-operator=${OPERATOR_EMAIL}`]);
  if([...args].some(arg=>!allowed.has(arg)))throw new Error("Unsupported bootstrap argument.");
  if(process.env.HIGUCHI_MODE!=="live")throw new Error("Set HIGUCHI_MODE=live explicitly before inspecting or applying the operator bootstrap.");
  const url=process.env.DATABASE_URL;if(!url)throw new Error("DATABASE_URL is required");
  const client=new SQL(url,{max:1,tls:process.env.DATABASE_SSL==="disable"?false:{rejectUnauthorized:true}});
  try{
    const result=await client.begin(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(724105301)`;
      await tx.unsafe("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';").simple();
      const snapshot:BootstrapSnapshot={users:await tx`SELECT id,email FROM users`,organizations:await tx`SELECT id,name,slug,metadata FROM organizations`,members:await tx`SELECT organization_id AS "organizationId",user_id AS "userId",role FROM members`};
      const plan=bootstrapPlan(snapshot);
      if(plan.status==="ready")return {...plan,changed:false};
      if(!apply)return {status:"ready-to-create",changed:false};
      const userId=randomUUID(),organizationId=randomUUID();
      await tx`INSERT INTO users (id,name,email,email_verified) VALUES (${userId},'MAORA運営',${OPERATOR_EMAIL},false)`;
      await tx`INSERT INTO organizations (id,name,slug,metadata) VALUES (${organizationId},${OPERATOR_ORGANIZATION},${OPERATOR_SLUG},${JSON.stringify({initial:true,bootstrapOperatorEmail:OPERATOR_EMAIL})})`;
      await tx`INSERT INTO members (id,organization_id,user_id,role) VALUES (${randomUUID()},${organizationId},${userId},'owner')`;
      return {status:"created",userId,organizationId,changed:true,emailVerified:false,passwordCreated:false};
    });
    console.log(JSON.stringify(result));
  }finally{await client.close();}
}
