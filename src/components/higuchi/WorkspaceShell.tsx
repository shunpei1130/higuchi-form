"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowUpRight, Bell, CalendarDays, CircleHelp, CreditCard, FlaskConical, House, Inbox, LoaderCircle, LogOut, Menu, Plus, RefreshCw, Settings, Sparkles, Users, X, Zap } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Brand, Button, usd } from "./ui";
import { useProject, useWorkspace, WorkspaceProvider } from "./workspace";
import { signOut } from "@/lib/auth/client";
import "./workspace.css";

const links = [{ href: "/app", label: "概要", icon: House }, { href: "/app/campaigns", label: "キャンペーン", icon: Zap }, { href: "/app/leads", label: "顧客候補", icon: Users }, { href: "/app/inbox", label: "受信箱", icon: Inbox }, { href: "/app/meetings", label: "商談予約", icon: CalendarDays }, { href: "/app/billing", label: "利用状況・請求", icon: CreditCard }, { href: "/app/settings", label: "設定", icon: Settings }];

function WorkspaceFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data, loading, error, notice, busy, perform, refresh, dismissError, dismissNotice } = useWorkspace();
  const project = useProject();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const logout = async () => { setSigningOut(true); setSessionError(""); try { const result = await signOut(); if (result.error) throw new Error("ログアウトできませんでした。もう一度お試しください。"); router.replace("/"); router.refresh(); } catch (cause) { setSessionError(cause instanceof Error ? cause.message : "ログアウトできませんでした。"); } finally { setSigningOut(false); } };
  const formatCredit=(value:number)=>usd(value,data?.billing.currency??"JPY");
  const unread = data?.conversations.filter((conversation) => conversation.unread).length ?? 0;
  const page = links.find((link) => link.href === "/app" ? pathname === "/app" : pathname.startsWith(link.href));
  return <div className="hf-app">
    {menuOpen && <button className="hf-mobile-scrim" aria-label="メニューを閉じる" onClick={() => setMenuOpen(false)} />}
    <aside className={`hf-sidebar ${menuOpen ? "is-open" : ""}`}>
      <div className="hf-sidebar-brand"><Brand /><button type="button" className="hf-icon-button hf-mobile-only" onClick={() => setMenuOpen(false)} aria-label="メニューを閉じる"><X size={20} /></button></div>
      <div className="hf-project-switcher"><label htmlFor="hf-project">プロジェクト</label><select id="hf-project" aria-label="プロジェクトを切り替え" value={project?.id ?? ""} disabled={busy || !data?.projects.length} onChange={(event) => void perform({ type: "project.select", projectId: event.target.value })}>{!data?.projects.length && <option value="">事業を設定してください</option>}{data?.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      <nav aria-label="メインナビゲーション">{links.map(({ href, label, icon: Icon }) => <Link key={href} href={href} aria-current={(href === "/app" ? pathname === href : pathname.startsWith(href)) ? "page" : undefined} className={`hf-nav-link ${(href === "/app" ? pathname === href : pathname.startsWith(href)) ? "is-active" : ""}`} onClick={() => setMenuOpen(false)}><Icon size={19} strokeWidth={1.7} aria-hidden="true" /><span>{label}</span>{href === "/app/inbox" && unread > 0 && <span className="hf-nav-count">{unread}</span>}</Link>)}</nav>
      <Link href="/app/onboarding" className="hf-new-project" onClick={() => setMenuOpen(false)}><Plus size={16} />プロジェクトを追加</Link>
      <div className="hf-sidebar-bottom"><div className="hf-credit-card"><div><Sparkles size={15} /><span>利用可能なクレジット</span></div><strong>{formatCredit(data?.billing.balanceCents ?? 0)}</strong><Link href="/app/billing">クレジットを追加<ArrowUpRight size={14} /></Link></div><Link href="/info/support" className="hf-sidebar-help"><CircleHelp size={17} />ヘルプ・サポート<ArrowUpRight size={14} /></Link><div className="hf-account"><span className="hf-avatar">{(data?.settings.displayName || "H").slice(0, 1)}</span><div><strong>{data?.settings.displayName || "ワークスペース"}</strong><span>{data?.mode === "simulation" ? "ローカルシミュレーション" : "営業ワークスペース"}</span></div>{data?.mode === "live" && <button type="button" className="hf-icon-button" style={{marginLeft:"auto"}} aria-label="ログアウト" title="ログアウト" disabled={signingOut} onClick={() => void logout()}>{signingOut ? <LoaderCircle className="hf-spin" size={15}/> : <LogOut size={15}/>}</button>}</div>{sessionError && <p role="alert" className="hf-subtle">{sessionError}</p>}</div>
    </aside>
    <div className="hf-workspace-body"><header className="hf-topbar"><div><button type="button" className="hf-icon-button hf-mobile-only" aria-label="メニューを開く" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Menu size={21} /></button><span className="hf-breadcrumb">{project?.name ?? "ワークスペース"}<span>/</span><strong>{pathname === "/app/onboarding" ? "事業を設定" : page?.label ?? "キャンペーン詳細"}</strong></span></div><div className="hf-topbar-actions"><button type="button" onClick={() => void refresh()} className="hf-icon-button" title="最新の状態に更新" aria-label="最新の状態に更新" disabled={busy}><RefreshCw size={17} className={busy ? "hf-spin" : undefined} /></button><Link href="/app/inbox" className="hf-icon-button hf-notification" aria-label={`受信箱、未読${unread}件`}><Bell size={18} />{unread > 0 && <span />}</Link><span className="hf-topbar-divider" /><span className="hf-avatar hf-avatar-small">{(data?.settings.displayName || "H").slice(0, 1)}</span></div></header>
      {data?.mode === "simulation" && <div className="hf-simulation-bar"><FlaskConical size={16} aria-hidden="true" /><span><strong>シミュレーション環境</strong>　架空の顧客・模擬送信・テスト決済で動作を確認できます。実際のメール送信・請求は行いません。</span></div>}
      <main id="hf-main" className="hf-main">{error && <div className="hf-alert" role="alert"><div>{error}</div><button type="button" className="hf-icon-button" aria-label="エラーを閉じる" onClick={dismissError}><X size={17} /></button></div>}{loading ? <div className="hf-loading" role="status"><LoaderCircle size={26} className="hf-spin" /><span>ワークスペースを読み込んでいます</span></div> : !data ? <div className="hf-empty"><h1>ワークスペースを読み込めませんでした</h1><p>接続をご確認のうえ、もう一度お試しください。</p><Button onClick={() => void refresh()}>再読み込み</Button></div> : children}</main>
    </div>{notice && <div className="hf-toast" role="status"><span>{notice}</span><button className="hf-icon-button" aria-label="通知を閉じる" onClick={dismissNotice}><X size={16} /></button></div>}
  </div>;
}

export default function WorkspaceShell({ children }: { children: ReactNode }) { return <WorkspaceProvider><WorkspaceFrame>{children}</WorkspaceFrame></WorkspaceProvider>; }
