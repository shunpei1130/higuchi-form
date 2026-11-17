import { ProductError } from "../state";
import { assertPreviewFixtureConfiguration } from "./fixture";
export function previewJson(value:unknown,status=200,cookie?:string|null):Response{return Response.json(value,{status,headers:{"Cache-Control":"no-store","X-Robots-Tag":"noindex, nofollow",...(cookie?{"Set-Cookie":cookie}:{})}});}
export function previewError(error:unknown):Response {if(error instanceof ProductError)return previewJson({error:error.message,code:error.code},error.status);return previewJson({error:"調査を処理できませんでした。時間をおいて再試行してください。",code:"PREVIEW_ERROR"},500);}
export function assertPreviewOrigin(request:Request):void {
  let origin:URL,expected:URL;try{origin=new URL(request.headers.get("origin")??"");expected=new URL(process.env.BETTER_AUTH_URL??process.env.NEXT_PUBLIC_APP_URL??request.url);}catch{throw new ProductError("同じサイトから操作してください。",403,"INVALID_ORIGIN");}
  if(origin.origin!==expected.origin)throw new ProductError("同じサイトから操作してください。",403,"INVALID_ORIGIN");
}
export function assertPreviewEnabled():void {assertPreviewFixtureConfiguration();if(process.env.HIGUCHI_PUBLIC_PREVIEW==="false")throw new ProductError("公開プレビューは準備中です。ログイン後の事業設定をご利用ください。",503,"PREVIEW_DISABLED");if(process.env.HIGUCHI_MODE!=="live")throw new ProductError("公開情報の調査には本番接続が必要です。",409,"PREVIEW_UNCONFIGURED");}
export async function readPreviewBody(request:Request):Promise<unknown>{
  if(Number(request.headers.get("content-length")??0)>20000)throw new ProductError("入力内容が長すぎます。",413,"PREVIEW_INPUT");
  const reader=request.body?.getReader();if(!reader)throw new ProductError("入力内容を確認してください。");let body="",length=0;const decoder=new TextDecoder();
  while(true){const item=await reader.read();if(item.done)break;length+=item.value.byteLength;if(length>20000){await reader.cancel();throw new ProductError("入力内容が長すぎます。",413,"PREVIEW_INPUT");}body+=decoder.decode(item.value,{stream:true});}
  body+=decoder.decode();try{return JSON.parse(body);}catch{throw new ProductError("入力内容を確認してください。",400,"PREVIEW_INPUT");}
}
