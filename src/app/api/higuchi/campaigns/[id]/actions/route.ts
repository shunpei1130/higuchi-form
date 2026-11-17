import { campaignTransition } from "@/lib/higuchi/rest";
export const runtime="nodejs";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){return campaignTransition(request,(await params).id);}
