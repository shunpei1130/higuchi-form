"use client";
import { useCallback, useEffect, useState } from "react";

type Status={connected:boolean;configured:boolean;emailAddress:string|null;detail:string;callbackUrl:string};
export function GoogleMailConnection({organizationId,disabled=false}:{organizationId:string;disabled?:boolean}){
  const [status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    if(!organizationId||disabled)return;
    const response=await fetch(`/api/higuchi/mail?organizationId=${encodeURIComponent(organizationId)}`,{credentials:"same-origin",cache:"no-store",signal});
    const result=await response.json();if(!response.ok)throw new Error(result.error??"接続状態を取得できませんでした。");setStatus(result);
  },[organizationId,disabled]);
  useEffect(()=>{setStatus(null);setError("");const controller=new AbortController();void refresh(controller.signal).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:"接続状態を取得できませんでした。");});return()=>controller.abort();},[refresh]);
  async function action(value:"connect"|"disconnect"){
    setBusy(true);setError("");try{
      const response=await fetch("/api/higuchi/mail",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({organizationId,action:value})});
      const result=await response.json();if(!response.ok)throw new Error(result.error??"接続を変更できませんでした。");
      if(value==="connect"&&typeof result.url==="string"){const url=new URL(result.url);if(url.origin!=="https://accounts.google.com")throw new Error("接続先を確認できませんでした。");window.location.assign(url.href);}else await refresh();
    }catch(e){setError(e instanceof Error?e.message:"接続を変更できませんでした。");}finally{setBusy(false);}
  }
  return <section className="operator-panel" aria-labelledby="google-mail-title"><h2 id="google-mail-title">2. Googleメール</h2><p>送信元は <strong>shumpei.hasegawa@maora.co.jp</strong> です。このアプリから開始した会話の返信だけを取得し、通常の業務メールは取り込みません。</p><p role="status">{status?.detail??"接続状態を確認しています。"}</p>{status?.emailAddress&&<p>接続中: {status.emailAddress}</p>}<button className={status?.connected?"op-secondary":"op-primary"} type="button" disabled={disabled||busy||!organizationId||!status?.configured} onClick={()=>void action(status?.connected?"disconnect":"connect")}>{busy?"処理中…":status?.connected?"Googleメールの接続を解除":"Googleアカウントを接続"}</button>{status&&!status.configured&&<p>Google Cloudに登録するリダイレクトURI: <code>{status.callbackUrl}</code></p>}{error&&<p role="alert">{error}</p>}</section>;
}
