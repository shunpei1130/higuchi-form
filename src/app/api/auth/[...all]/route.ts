import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth/server";
import { isHiguchiSimulation } from "@/lib/higuchi/mode";

// Better Auth's endpoints: /api/auth/sign-in/*, /sign-up/*, /sign-out,
// /get-session, /organization/*, /callback/google, … (public in proxy.ts).
const handlers = toNextJsHandler(auth);
function simulationResponse(request: Request) {
  if (request.method === "GET" && new URL(request.url).pathname === "/api/auth/get-session") return Response.json(null);
  return Response.json({ error: "検証モードではログインせずにお試しください。", code: "SIMULATION_AUTH_DISABLED" }, { status: 409 });
}
export async function GET(request: Request) { return isHiguchiSimulation() ? simulationResponse(request) : handlers.GET(request); }
export async function POST(request: Request) { return isHiguchiSimulation() ? simulationResponse(request) : handlers.POST(request); }
