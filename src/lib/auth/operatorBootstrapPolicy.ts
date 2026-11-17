export const OPERATOR_EMAIL="s.hasegawa1130@gmail.com";
export const OPERATOR_ORGANIZATION="MAORA";
export const OPERATOR_SLUG="maora";
export type BootstrapSnapshot={users:Array<{id:string;email:string}>;organizations:Array<{id:string;name:string;slug:string;metadata:string|null}>;members:Array<{organizationId:string;userId:string;role:string}>};
export function bootstrapPlan(snapshot:BootstrapSnapshot):{status:"create"}|{status:"ready";organizationId:string;userId:string}{
  const initial=snapshot.organizations.filter(org=>{try{return JSON.parse(org.metadata??"{}").initial===true;}catch{throw new Error("既存組織のメタデータが不正です。自動で変更しません。");}});
  const owner=snapshot.users.find(user=>user.email.toLowerCase()===OPERATOR_EMAIL);
  const existing=initial[0];
  if(initial.length===1&&existing&&owner&&existing.slug===OPERATOR_SLUG&&existing.name===OPERATOR_ORGANIZATION){
    let metadata:Record<string,unknown>;try{metadata=JSON.parse(existing.metadata??"{}");}catch{throw new Error("初期組織を確認できません。");}
    if(metadata.bootstrapOperatorEmail===OPERATOR_EMAIL&&snapshot.members.some(member=>member.organizationId===existing.id&&member.userId===owner.id&&member.role.split(",").includes("owner")))return {status:"ready",organizationId:existing.id,userId:owner.id};
  }
  if(snapshot.users.length||snapshot.organizations.length||snapshot.members.length)throw new Error("既存のアカウントまたは組織があります。権限の付け替えや認証状態の上書きは行いません。");
  return {status:"create"};
}
export function bootstrapEnabledForWeb(environment:{nodeEnv?:string;vercel?:string}):boolean{return environment.nodeEnv!=="production"&&environment.vercel!=="1";}
