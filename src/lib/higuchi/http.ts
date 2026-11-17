import { ProductError } from "./state";

export function workspaceResponse(result: {workspace:unknown;cookie:string|null}):Response {
  const headers:Record<string,string>={"Cache-Control":"no-store"};if(result.cookie)headers["Set-Cookie"]=result.cookie;
  return Response.json(result.workspace,{headers});
}
export async function productErrorResponse(error:unknown):Promise<Response> {
  if(error instanceof ProductError)return Response.json({error:error.message,code:error.code},{status:error.status,headers:{"Cache-Control":"no-store"}});
  const {authContextErrorResponse}=await import("@/lib/auth/context");const authError=authContextErrorResponse(error);if(authError)return authError;
  const candidate=error as {message?:string;status?:number};
  const status=candidate.status&&candidate.status>=400&&candidate.status<600?candidate.status:500;
  console.error("[higuchi] request failed",candidate.message||error);
  return Response.json({error:status===500?"処理を完了できませんでした。接続設定とデータベースを確認してください。":candidate.message||"処理を完了できませんでした。"},{status});
}
