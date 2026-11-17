"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { WorkspaceAction, WorkspaceSnapshot } from "@/lib/higuchi/types";

type WorkspaceContextValue = {
  data: WorkspaceSnapshot | null; loading: boolean; busy: boolean; error: string | null; notice: string | null;
  perform: (action: WorkspaceAction) => Promise<WorkspaceSnapshot | null>;
  refresh: () => Promise<void>; dismissNotice: () => void; dismissError: () => void;
};
const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [data, setData] = useState<WorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const request = useCallback(async (action?: WorkspaceAction, signal?: AbortSignal) => {
    const response = await fetch(action ? "/api/higuchi/actions" : "/api/higuchi/workspace", { method: action ? "POST" : "GET", credentials: "same-origin", cache: "no-store", headers: action ? { "Content-Type": "application/json" } : undefined, body: action ? JSON.stringify(action) : undefined, signal });
    const value = await response.json();
    if (!response.ok) {
      const from = `${window.location.pathname}${window.location.search}`;
      if (response.status === 401) router.replace(`/sign-in?from=${encodeURIComponent(from)}`);
      if (response.status === 409 && value.code === "NO_ACTIVE_ORGANIZATION") router.replace(`/onboarding?from=${encodeURIComponent(from)}`);
      throw new Error(value.error || "処理を完了できませんでした。もう一度お試しください。");
    }
    const snapshot = value as WorkspaceSnapshot;
    if (mounted.current) { setData(snapshot); if (snapshot.notice) setNotice(snapshot.notice); }
    if (snapshot.redirectUrl) window.location.assign(snapshot.redirectUrl);
    return snapshot;
  }, [router]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    request(undefined, controller.signal).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "ワークスペースを読み込めませんでした。"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { mounted.current = false; controller.abort(); };
  }, [request]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 6500); return () => clearTimeout(timer); }, [notice]);
  const perform = useCallback(async (action: WorkspaceAction) => {
    setPending((value) => value + 1); setError(null);
    try { return await request(action); } catch (cause) { setError(cause instanceof Error ? cause.message : "処理を完了できませんでした。"); return null; } finally { if (mounted.current) setPending((value) => Math.max(0, value - 1)); }
  }, [request]);
  const refresh = useCallback(async () => { setError(null); try { await request(); } catch (cause) { setError(cause instanceof Error ? cause.message : "再読み込みできませんでした。"); } }, [request]);
  const value = useMemo(() => ({ data, loading, busy: pending > 0, error, notice, perform, refresh, dismissNotice: () => setNotice(null), dismissError: () => setError(null) }), [data, loading, pending, error, notice, perform, refresh]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() { const context = useContext(WorkspaceContext); if (!context) throw new Error("WorkspaceProvider is required"); return context; }
export function useProject() { const { data } = useWorkspace(); return data?.projects.find((project) => project.id === data.activeProjectId) ?? data?.projects[0] ?? null; }
