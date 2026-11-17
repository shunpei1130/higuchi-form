import { emptyPreviewState, type CreatePreviewInput, type PreviewStatus } from "./types";

export const PREVIEW_SCRUBBED_CODE="PREVIEW_CONTENT_SCRUBBED";
/** Keep opaque identity/cost links, while removing all company, contact, draft and provider-error content. */
export function expiredPreviewPatch(run:{status:PreviewStatus;revision:number;generation:number},now:Date) {
  const state=emptyPreviewState();state.notice="匿名調査の保存期限が切れたため、入力内容と調査結果を削除しました。";
  const input:CreatePreviewInput={website:"",business:"",customer:"",geography:""};
  return {input,state,status:(run.status==="claimed"?"claimed":"failed") as PreviewStatus,revision:run.revision+1,generation:run.generation+1,stageIndex:0,lockedBy:null,leaseUntil:null,errorCode:PREVIEW_SCRUBBED_CODE,errorMessage:null,errorRetryable:0,updatedAt:now};
}
/** Invalidates the old high-entropy cookie without removing the referenced session row. */
export function expiredPreviewTokenHash(id:string):string{return `expired:${id}`;}
