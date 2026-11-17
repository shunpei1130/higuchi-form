"use client";

import { useEffect, useState, type FormEvent } from "react";
import { authClient, useListOrganizations, useSession } from "@/lib/auth/client";
import { slugify } from "@/lib/auth/slug";
import { AuthShell } from "@/components/auth/AuthShell";
import { ErrorCallout, Field, SecondaryButton, SubmitButton } from "@/components/auth/fields";
import { safeFrom } from "@/components/auth/safeFrom";

export default function OnboardingPage() {
  const { data: session, isPending } = useSession();
  const { data: orgs } = useListOrganizations();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [target, setTarget] = useState("/app");

  useEffect(() => { setTarget(safeFrom(new URLSearchParams(window.location.search).get("from")) || "/app"); }, []);

  useEffect(() => {
    if (!isPending && !session) window.location.href = `/sign-in?from=${encodeURIComponent(window.location.pathname+window.location.search)}`;
  }, [isPending, session]);

  function onName(value: string) {
    setName(value);
    if (!slugEdited) setSlug(slugify(value) || `workspace-${crypto.randomUUID().slice(0,8)}`);
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setError("");
    const finalSlug = slugify(slug);
    if (!name.trim() || !finalSlug) return setError("ワークスペース名を入力してください。");
    setLoading(true);
    const check = await authClient.organization.checkSlug({ slug: finalSlug });
    if (check.error || !check.data?.status) {
      setError("この名前はすでに使われています。別の名前を入力してください。");
      return setLoading(false);
    }
    const created = await authClient.organization.create({ name: name.trim(), slug: finalSlug });
    if (created.error || !created.data) {
      setError(created.error?.message || "ワークスペースを作成できませんでした。");
      return setLoading(false);
    }
    const active = await authClient.organization.setActive({ organizationId: created.data.id });
    if (active.error) {
      setError(active.error.message || "作成後の切り替えに失敗しました。画面を再読み込みしてください。");
      return setLoading(false);
    }
    window.location.assign(target);
  }

  async function switchTo(id: string) {
    setError("");
    setSwitching(id);
    const { error: err } = await authClient.organization.setActive({ organizationId: id });
    if (err) {
      setError(err.message || "ワークスペースを切り替えられませんでした。");
      return setSwitching(null);
    }
    window.location.assign(target);
  }

  const hasOrgs = !!orgs && orgs.length > 0;

  return (
    <AuthShell
      title={hasOrgs ? "ワークスペースを選択" : "ワークスペースを作成"}
      subtitle={hasOrgs ? "利用するワークスペースを選ぶか、新しく作成してください。" : "顧客、キャンペーン、会話をまとめて管理します。"}
    >
      <div className="flex flex-col gap-4">
        {hasOrgs && (
          <div className="flex flex-col gap-2">
            {orgs.map((o) => (
              <SecondaryButton key={o.id} onClick={() => switchTo(o.id)} loading={switching === o.id} disabled={!!switching}>
                {o.name}
              </SecondaryButton>
            ))}
            <div className="mt-2 text-xs uppercase tracking-widest text-slate-600">新しいワークスペースを作成</div>
          </div>
        )}
        <form onSubmit={create} className="flex flex-col gap-4">
          <Field label="ワークスペース名" type="text" autoComplete="organization" required value={name} onChange={(e) => onName(e.target.value)} />
          <Field
            label="URL用の名前"
            type="text"
            autoComplete="off"
            required
            hint="半角の英小文字、数字、ハイフンを使えます。"
            value={slug}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value);
            }}
          />
          {error && <ErrorCallout>{error}</ErrorCallout>}
          <SubmitButton loading={loading} loadingLabel="作成中…" disabled={!!switching}>
            ワークスペースを作成
          </SubmitButton>
        </form>
      </div>
    </AuthShell>
  );
}
