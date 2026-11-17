export const PREVIEW_RUN_BUDGET_MICROS=100000;
export const WEB_SEARCH_MICROS=10000;
/** The bounded web context is additional to caller input; token bytes bound caller text conservatively. */
export function previewAiReservation(input:{system:string;user:string;maxOutputTokens:number;maxSearchCalls:number}):number {
  // Each built-in call can add model context. Do not treat a call-count limit as a token limit.
  const inputTokens=Buffer.byteLength(input.system+input.user,"utf8")+10000+input.maxSearchCalls*128000;
  return Math.ceil(inputTokens*.10+input.maxOutputTokens*.50+input.maxSearchCalls*WEB_SEARCH_MICROS);
}
export function previewAiActual(inputTokens:number,outputTokens:number,searchCalls:number):number{return Math.ceil(inputTokens*.10+outputTokens*.50+searchCalls*WEB_SEARCH_MICROS);}
export function assertPreviewBudget(runUsed:number,monthUsed:number,reservation:number,monthLimit:number):void {
  if(!Number.isFinite(monthLimit)||monthLimit<=0||!Number.isSafeInteger(reservation)||reservation<0)throw new Error("AI_BUDGET");
  if(runUsed+reservation>PREVIEW_RUN_BUDGET_MICROS)throw new Error("PREVIEW_RUN_BUDGET");
  if(monthUsed+reservation>monthLimit)throw new Error("AI_BUDGET_EXCEEDED");
}
