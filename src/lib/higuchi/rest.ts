import { assertSameOrigin, dispatchWorkspace, readWorkspace } from "./service";
import { productErrorResponse, workspaceResponse } from "./http";
import { readJsonObject, validateAction } from "./validation";
import { ProductError } from "./state";
import type { WorkspaceAction, WorkspaceSnapshot } from "./types";

export async function productRead(request:Request,select:(state:WorkspaceSnapshot)=>unknown):Promise<Response>{try{const result=await readWorkspace(request);return workspaceResponse({workspace:select(result.workspace),cookie:result.cookie});}catch(error){return productErrorResponse(error);}}
export async function productWrite(request:Request,type:WorkspaceAction["type"],extra:Record<string,unknown>={}):Promise<Response>{try{assertSameOrigin(request);const body=await readJsonObject(request);return workspaceResponse(await dispatchWorkspace(request,validateAction({...body,...extra,type})));}catch(error){return productErrorResponse(error);}}
export async function campaignTransition(request:Request,campaignId:string):Promise<Response>{try{assertSameOrigin(request);const body=await readJsonObject(request);if(Object.keys(body).some(k=>k!=="action")||typeof body.action!=="string"||!["start","stop","archive","restore","approve"].includes(body.action))throw new ProductError("キャンペーンの操作を指定してください。");const action=validateAction({type:`campaign.${body.action}`,campaignId});return workspaceResponse(await dispatchWorkspace(request,action));}catch(error){return productErrorResponse(error);}}
