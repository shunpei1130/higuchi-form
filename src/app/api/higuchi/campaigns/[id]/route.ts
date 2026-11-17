import { productRead, productWrite } from "@/lib/higuchi/rest";
import { ProductError } from "@/lib/higuchi/state";
export const runtime="nodejs";
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,{params}:Context){const {id}=await params;return productRead(request,state=>{const campaign=state.campaigns.find(c=>c.id===id);if(!campaign)throw new ProductError("キャンペーンが見つかりません。",404);return campaign;});}
export async function PATCH(request:Request,{params}:Context){const {id}=await params;return productWrite(request,"campaign.update",{campaignId:id});}
