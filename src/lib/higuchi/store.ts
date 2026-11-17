import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { assertSimulationRequest } from "./mode";
import { createWorkspace, normalizeWorkspaceState, ProductError, type WorkspaceState } from "./state";

export const SIMULATION_COOKIE = "hf_sim_session";
export type WorkspaceMutation<T> = (state: WorkspaceState) => Promise<T> | T;
type AtomicReplaceDependencies={rename?:(source:string,destination:string)=>Promise<void>;wait?:(milliseconds:number)=>Promise<void>};
/** Windows scanners can briefly hold the destination open. Retry the atomic rename, never delete it. */
export async function atomicReplace(source:string,destination:string,dependencies:AtomicReplaceDependencies={}):Promise<void>{
  const replace=dependencies.rename??rename,wait=dependencies.wait??((milliseconds:number)=>new Promise<void>(resolve=>setTimeout(resolve,milliseconds)));
  for(let attempt=0;attempt<10;attempt++){
    try{await replace(source,destination);return;}
    catch(error){const code=(error as NodeJS.ErrnoException).code;if(!["EPERM","EACCES","EBUSY"].includes(code??"")||attempt===9)throw error;await wait(Math.min(250,25*2**attempt));}
  }
}
// Keep runtime writes outside Next/Turbopack's watched source tree. A GET must never trigger HMR.
const storageRoot = () => path.resolve(process.env.HIGUCHI_SIMULATION_DIRECTORY || path.join(tmpdir(), "higuchi-form", createHash("sha256").update(path.resolve(process.cwd())).digest("hex").slice(0,16), "simulation"));
let secretPromise: Promise<string> | undefined;
async function signingSecret(): Promise<string> {
  if (process.env.HIGUCHI_SESSION_SECRET) return process.env.HIGUCHI_SESSION_SECRET;
  secretPromise ??= (async () => {
    const root = storageRoot(); await mkdir(root, { recursive: true }); const filename = path.join(root, "session-secret");
    try { return await readFile(filename, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const secret = randomBytes(32).toString("hex");
    try { await writeFile(filename, secret, { flag: "wx", mode: 0o600 }); return secret; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; return readFile(filename, "utf8"); }
  })();
  return secretPromise;
}
function signature(value: string, secret: string): string { return createHmac("sha256", secret).update(value).digest("hex"); }
export async function resolveSimulationSession(request: Request): Promise<{ id: string; cookie: string | null }> {
  assertSimulationRequest(request);
  const raw = request.headers.get("cookie")?.split(";").map((v) => v.trim()).find((v) => v.startsWith(`${SIMULATION_COOKIE}=`))?.slice(SIMULATION_COOKIE.length + 1);
  const secret = await signingSecret();
  if (raw) {
    const [session, supplied] = raw.split(".");
    if (/^[0-9a-f-]{36}$/.test(session ?? "") && /^[0-9a-f]{64}$/.test(supplied ?? "")) {
      const expected = signature(session, secret);
      if (timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"))) return { id: session, cookie: null };
    }
  }
  const session = randomUUID();
  return { id: session, cookie: `${SIMULATION_COOKIE}=${session}.${signature(session, secret)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` };
}
async function acquireLock(filename: string): Promise<() => Promise<void>> {
  const lock = `${filename}.lock`;
  for (let attempt = 0; attempt < 300; attempt++) {
    try { await mkdir(lock); return async () => { await rm(lock, { recursive: true, force: true }); }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let age: number;
      try { age = Date.now() - (await stat(lock)).mtimeMs; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (age > 120000) { await rm(lock, { recursive: true, force: true }); continue; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new ProductError("別の操作を処理中です。少し待って再度お試しください。", 409, "BUSY");
}
export async function mutateSimulation<T>(sessionId: string, fn: WorkspaceMutation<T>, baseNow = new Date()): Promise<{ result: T; state: WorkspaceState }> {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) throw new ProductError("セッションを確認してください。", 401);
  const root = storageRoot(); await mkdir(root, { recursive: true }); const filename = path.join(root, `${sessionId}.json`); const release = await acquireLock(filename);
  try {
    let state: WorkspaceState;
    try { state = JSON.parse(await readFile(filename, "utf8")) as WorkspaceState; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; state = createWorkspace("simulation", baseNow.toISOString()); }
    normalizeWorkspaceState(state);state.mode="simulation";
    state.now = new Date(baseNow.getTime() + state.internal.clockOffsetMs).toISOString();
    const result = await fn(state);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    try{await atomicReplace(temporary,filename);}catch(error){await rm(temporary,{force:true}).catch(()=>{});throw error;}
    return { result, state };
  } finally { await release(); }
}
export async function mutateLive<T>(fn: (state:WorkspaceState,tx:import("./jobs/store").JobsTransaction)=>Promise<T>|T): Promise<{ result: T; state: WorkspaceState }> {
  const [{ db }, { higuchiWorkspaces }, { currentOrganizationId, inOrg }] = await Promise.all([import("@/lib/db"), import("./schema"), import("@/lib/tenancy/scope")]);
  const organizationId = currentOrganizationId();
  return db.transaction(async (tx) => {
    await tx.insert(higuchiWorkspaces).values({ organizationId, state: createWorkspace("live") }).onConflictDoNothing();
    const [row] = await tx.select().from(higuchiWorkspaces).where(inOrg(higuchiWorkspaces)).for("update");
    if (!row) throw new ProductError("ワークスペースが見つかりません。", 404);
    const state = normalizeWorkspaceState(structuredClone(row.state)); state.mode="live"; state.now = new Date().toISOString();
    const result = await fn(state,tx);
    await tx.update(higuchiWorkspaces).set({ state, updatedAt: new Date() }).where(eq(higuchiWorkspaces.organizationId, organizationId));
    return { result, state };
  });
}
