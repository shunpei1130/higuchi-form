"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PreviewAction, PreviewSnapshot } from "@/lib/higuchi/preview/types";
import { getPreview, patchPreview, PreviewRequestError } from "./api";

export function usePreview(id: string) {
  const [data, setData] = useState<PreviewSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [fatal, setFatal] = useState(false);
  const latest = useRef<PreviewSnapshot | null>(null);
  const alive = useRef(true);
  const accept = useCallback((snapshot: PreviewSnapshot) => {
    if (!alive.current || latest.current && latest.current.revision > snapshot.revision) return;
    latest.current = snapshot;
    setData(snapshot);
  }, []);
  const refresh = useCallback(async () => {
    const snapshot = await getPreview(id); accept(snapshot); return snapshot;
  }, [id, accept]);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    async function poll() {
      try {
        const snapshot = await getPreview(id, controller.signal);
        accept(snapshot); setFatal(false); setPollError("");
      } catch (cause) {
        if (controller.signal.aborted) return;
        const terminal = cause instanceof PreviewRequestError && [401, 403, 404, 410].includes(cause.status);
        setPollError(cause instanceof Error ? cause.message : "準備状況を取得できませんでした。");
        setFatal(terminal); stopped = terminal;
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (!stopped) timer = setTimeout(poll, document.hidden ? 8000 : 2000);
        }
      }
    }
    if (!id) { setLoading(false); setFatal(true); setError("準備する事業がまだ選ばれていません。トップからURLを入力してください。"); }
    else void poll();
    return () => { alive.current = false; controller.abort(); clearTimeout(timer); };
  }, [id, accept]);

  const perform = useCallback(async (action: PreviewAction): Promise<boolean> => {
    if (!latest.current || pending) return false;
    setPending(true); setError("");
    try { accept(await patchPreview(id, { revision: latest.current.revision, action })); return true; }
    catch (cause) {
      if (cause instanceof PreviewRequestError && cause.status === 409) {
        try { await refresh(); } catch { /* Keep the original conflict explanation. */ }
        setError("準備状況が更新されました。入力内容は保持しています。確認して、もう一度保存してください。");
      } else setError(cause instanceof Error ? cause.message : "変更を保存できませんでした。");
      return false;
    } finally { if (alive.current) setPending(false); }
  }, [id, accept, pending, refresh]);
  return { data, loading, pending, error: error || pollError, fatal, perform, refresh, clearError: () => { setError(""); setPollError(""); } };
}
