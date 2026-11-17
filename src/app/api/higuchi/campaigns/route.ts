import { productRead, productWrite } from "@/lib/higuchi/rest";
export const runtime="nodejs";
export async function GET(request:Request){const projectId=new URL(request.url).searchParams.get("projectId");return productRead(request,state=>({campaigns:state.campaigns.filter(c=>!projectId||c.projectId===projectId),mode:state.mode}));}
export async function POST(request:Request){return productWrite(request,"campaign.propose");}
