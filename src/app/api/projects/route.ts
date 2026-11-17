import { productRead, productWrite } from "@/lib/higuchi/rest";
export const runtime="nodejs";
export async function GET(request:Request){return productRead(request,state=>({projects:state.projects,activeProjectId:state.activeProjectId,mode:state.mode}));}
export async function POST(request:Request){return productWrite(request,"project.create");}
