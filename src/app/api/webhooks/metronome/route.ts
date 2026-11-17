export const runtime = "nodejs";
export async function POST(): Promise<Response> {
  return Response.json({error:"この通知先は利用できません。"},{status:404});
}
