import { readWorkspace } from "@/lib/higuchi/service";
import { productErrorResponse, workspaceResponse } from "@/lib/higuchi/http";
export const runtime="nodejs";
export async function GET(request:Request){try{return workspaceResponse(await readWorkspace(request));}catch(error){return productErrorResponse(error);}}
