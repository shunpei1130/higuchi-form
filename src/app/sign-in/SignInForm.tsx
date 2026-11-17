"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, LoaderCircle, Mail } from "lucide-react";
import { RiLinkedinBoxFill } from "@remixicon/react";
import { authClient } from "@/lib/auth/client";
import { AuthShell } from "@/components/auth/AuthShell";

export function SignInForm({ from, linkedinEnabled=false, simulation=false, signup=false }: { from: string | null; googleEnabled?: boolean; signupAvailable?: boolean; linkedinEnabled?: boolean; simulation?: boolean; signup?: boolean }) {
  const target = from || "/app";
  const [email,setEmail]=useState("");
  const [code,setCode]=useState("");
  const [sent,setSent]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      if (!sent) {
        const result=await authClient.emailOtp.sendVerificationOtp({email:email.trim(),type:"sign-in"});
        if(result.error) throw new Error("認証メールを送信できませんでした。メールアドレスと配信設定をご確認ください。");
        setSent(true);
      } else {
        const result=await authClient.signIn.emailOtp({email:email.trim(),otp:code});
        if(result.error) throw new Error("コードが正しくないか、有効期限が切れています。もう一度お試しください。");
        window.location.assign(target);
      }
    } catch(err) {setError(err instanceof Error?err.message:"通信できませんでした。もう一度お試しください。");}
    finally {setBusy(false);}
  }
  return <AuthShell title={signup?"アカウントを作成する":"アカウントにログイン"} subtitle={simulation?"ローカルの検証環境です":"仕事用のメールアドレスで始められます"}>
    {simulation ? <div className="hf-auth-stack"><p className="hf-auth-notice">検証モードではログイン不要です。架空のデータを使って操作を確認できます。メールは送信されず、料金も発生しません。</p><Link className="hf-auth-primary" href={target}>検証用の管理画面を開く<ArrowRight size={17}/></Link></div> : <>
      <form className="hf-auth-stack" onSubmit={submit}>
        <label>メールアドレス<div className="hf-auth-input"><Mail size={17}/><input type="email" required autoComplete="email" placeholder="you@company.com" value={email} disabled={sent||busy} onChange={e=>setEmail(e.target.value)} /></div></label>
        {sent && <><p className="hf-auth-notice">メールに届いた6桁のコードを入力してください。コードは5分間有効です。</p><label>認証コード<input className="hf-auth-code" aria-label="認証コード" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,""))}/></label></>}
        {error && <p className="hf-auth-error" role="alert">{error}</p>}
        <button className="hf-auth-primary" disabled={busy}>{busy?<LoaderCircle size={18} className="animate-spin"/>:sent?"ログインする":"認証コードを送る"}</button>
        {sent && <button type="button" className="hf-auth-text" onClick={()=>{setSent(false);setCode("");setError("");}}>メールアドレスを変更・コードを再送</button>}
      </form>
      <div className="hf-auth-divider"><span>または</span></div>
      <button className="hf-auth-social" disabled={!linkedinEnabled||busy} onClick={async()=>{setBusy(true);const result=await authClient.signIn.social({provider:"linkedin",callbackURL:target});if(result.error){setError("LinkedInでログインできませんでした。");setBusy(false);}}}><RiLinkedinBoxFill size={19}/>LinkedInで続ける</button>
      {!linkedinEnabled && <p className="hf-auth-caption">LinkedInログインは運営者による接続設定が必要です。</p>}
      <p className="hf-auth-caption">{signup?"すでにアカウントをお持ちですか？":"初めてご利用ですか？"} <Link href={`${signup?"/sign-in":"/sign-up"}?from=${encodeURIComponent(target)}`}>{signup?"ログイン":"アカウントを作成"}</Link></p>
    </>}
    <p className="hf-auth-legal"><Link href="/info/terms">利用について</Link><span> · </span><Link href="/info/privacy">プライバシー</Link></p>
  </AuthShell>;
}
