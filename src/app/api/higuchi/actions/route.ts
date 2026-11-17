import { assertSameOrigin, dispatchWorkspace, parseAction } from "@/lib/higuchi/service";
import { productErrorResponse, workspaceResponse } from "@/lib/higuchi/http";
export const runtime="nodejs";
export async function POST(request:Request){try{assertSameOrigin(request);return workspaceResponse(await dispatchWorkspace(request,await parseAction(request)));}catch(error){return productErrorResponse(error);}}
