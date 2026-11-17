import { productRead, productWrite } from "@/lib/higuchi/rest";
import { ProductError } from "@/lib/higuchi/state";
export const runtime="nodejs";
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,{params}:Context){const {id}=await params;return productRead(request,state=>{const project=state.projects.find(p=>p.id===id);if(!project)throw new ProductError("プロジェクトが見つかりません。",404);return project;});}
export async function PATCH(request:Request,{params}:Context){const {id}=await params;return productWrite(request,"project.update",{projectId:id});}
