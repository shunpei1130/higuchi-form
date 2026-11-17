import type { ProductMode } from "./types";

/** Simulation is explicit, never inferred from missing database/provider credentials. */
export function higuchiMode(env: Record<string, string | undefined> = process.env): ProductMode {
  return env.HIGUCHI_MODE === "simulation" ? "simulation" : "live";
}
export const getHiguchiMode = higuchiMode;
export function isHiguchiSimulation(env: Record<string, string | undefined> = process.env): boolean {
  return higuchiMode(env) === "simulation";
}
export function isLoopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname.toLowerCase());
}
export function assertSimulationRequest(request: Request): void {
  let actualHost:URL;
  try{actualHost=new URL(`http://${request.headers.get("host")??new URL(request.url).host}`);}catch{throw Object.assign(new Error("接続先ホストを確認してください。"),{status:403});}
  if (!isHiguchiSimulation() || !isLoopbackHost(new URL(request.url).hostname)||!isLoopbackHost(actualHost.hostname)) {
    throw Object.assign(new Error("シミュレーションは明示的に有効化したローカル環境でのみ利用できます。"),{status:403});
  }
}
