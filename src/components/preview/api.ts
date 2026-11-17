import type { CreatePreviewInput, PatchPreviewInput, PreviewSnapshot } from "@/lib/higuchi/preview/types";

export class PreviewRequestError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as (T & { error?: string | { message?: string; code?: string }; code?: string }) | null;
  if (!response.ok) {
    const error = body?.error;
    throw new PreviewRequestError(typeof error === "string" ? error : error?.message || "通信を完了できませんでした。もう一度お試しください。", response.status, body?.code || (typeof error === "object" ? error.code : undefined));
  }
  if (!body) throw new PreviewRequestError("応答を読み取れませんでした。", 502);
  return body;
}

export async function createPreview(input: CreatePreviewInput): Promise<PreviewSnapshot> {
  return readResponse<PreviewSnapshot>(await fetch("/api/previews", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }));
}

export async function getPreview(id: string, signal?: AbortSignal): Promise<PreviewSnapshot> {
  return readResponse<PreviewSnapshot>(await fetch(`/api/previews/${encodeURIComponent(id)}`, { credentials: "same-origin", cache: "no-store", signal }));
}

export async function patchPreview(id: string, input: PatchPreviewInput): Promise<PreviewSnapshot> {
  return readResponse<PreviewSnapshot>(await fetch(`/api/previews/${encodeURIComponent(id)}`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }));
}

export type PreviewClaim = { projectId: string; campaignIds: string[]; sample: false; redirectUrl: string };
export async function claimPreview(id: string, revision: number, requestId: string): Promise<PreviewClaim> {
  return readResponse<PreviewClaim>(await fetch(`/api/previews/${encodeURIComponent(id)}/claim`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision, requestId }) }));
}

export async function startPreview(id: string, requestId: string): Promise<{ started: true; projectId: string; campaignIds: string[]; redirectUrl: string }> {
  return readResponse(await fetch(`/api/previews/${encodeURIComponent(id)}/start`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, consent: true }) }));
}

export async function consentPreview(id: string, requestId: string, sessionId: string): Promise<void> {
  await readResponse(await fetch(`/api/previews/${encodeURIComponent(id)}/consent`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, sessionId, consent: true }) }));
}
