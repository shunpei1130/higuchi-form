"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { CheckoutElementsProvider, PaymentElement, useCheckoutElements } from "@stripe/react-stripe-js/checkout";
import { formatMoney } from "@/lib/higuchi/money";

export type EmbeddedCheckoutProps={mode:"setup"|"payment";amountMinor?:number;previewRunId?:string;disabled?:boolean;confirmLabel?:string;onBeforeConfirm?:(sessionId:string)=>void|Promise<void>;onComplete?:()=>void;onResumeRequired?:()=>void;onError?:(message:string)=>void};
type Session={clientSecret:string;publishableKey:string;sessionId:string;currency:"JPY";priceVersion:string};
const stripeClients=new Map<string,Promise<Stripe|null>>();
function client(key:string){let value=stripeClients.get(key);if(!value){value=loadStripe(key,{locale:"ja"});stripeClients.set(key,value);}return value;}

/** The parent mounts this only after verified email and a real-data preview claim. Card data goes directly to Stripe. */
export function EmbeddedCheckout(props:EmbeddedCheckoutProps){
  const [session,setSession]=useState<Session|null>(null),[error,setError]=useState("");
  const callback=useRef(props.onError);callback.current=props.onError;
  const resumeCallback=useRef(props.onResumeRequired);resumeCallback.current=props.onResumeRequired;
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    const abort=new AbortController();let active=true;
    setSession(null);setError("");
    const requestId=crypto.randomUUID();
    void fetch("/api/higuchi/billing/checkout-elements",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",signal:abort.signal,body:JSON.stringify({mode:props.mode,amountMinor:props.amountMinor,previewRunId:props.previewRunId,requestId,returnPath:window.location.pathname+window.location.search})})
      .then(async response=>{const body=await response.json();if(!response.ok){if(active&&body.code==="CHECKOUT_ALREADY_CONFIRMED")resumeCallback.current?.();throw new Error(typeof body.error==="string"?body.error:"カード入力の準備ができませんでした。");}if(body.currency!=="JPY"||typeof body.clientSecret!=="string"||!String(body.publishableKey).startsWith("pk_"))throw new Error("カード入力の接続を確認できませんでした。");return body as Session;})
      .then(result=>{if(active)setSession(result);})
      .catch(cause=>{if(!active||abort.signal.aborted)return;const message=cause instanceof Error?cause.message:"カード入力を準備できませんでした。";setError(message);callback.current?.(message);});
    return()=>{active=false;abort.abort();};
  },[props.mode,props.amountMinor,props.previewRunId,attempt]);
  const options=useMemo(()=>session?{clientSecret:session.clientSecret,elementsOptions:{appearance:{theme:"stripe" as const,variables:{colorPrimary:"#089e75",colorBackground:"#f6f5f3",borderRadius:"8px",fontFamily:'Arial, "Noto Sans JP", sans-serif'}}}}:null,[session]);
  if(error)return <div role="alert" className="hf-checkout-error"><p>{error}</p><button type="button" onClick={()=>setAttempt(value=>value+1)}>接続を再確認</button></div>;
  if(!session||!options)return <div role="status" aria-live="polite" style={{padding:"22px 0",color:"#71717a"}}>安全なカード入力を準備しています…</div>;
  return <CheckoutElementsProvider key={session.sessionId} stripe={client(session.publishableKey)} options={options}><CardForm {...props} sessionId={session.sessionId}/></CheckoutElementsProvider>;
}

function CardForm({mode,amountMinor,disabled,confirmLabel,onBeforeConfirm,onComplete,onError,sessionId}:EmbeddedCheckoutProps&{sessionId:string}){
  const checkoutState=useCheckoutElements();const [busy,setBusy]=useState(false),[error,setError]=useState(""),[complete,setComplete]=useState(false);
  async function submit(event:FormEvent){
    event.preventDefault();if(disabled||busy||complete||checkoutState.type!=="success")return;
    setBusy(true);setError("");
    try{
      await onBeforeConfirm?.(sessionId);
      const result=await checkoutState.checkout.confirm({redirect:"if_required"});
      if(result.type==="error")throw new Error(result.error.message||"カードの確認が完了しませんでした。");
      setComplete(true);onComplete?.();
    }catch(cause){const message=cause instanceof Error?cause.message:"カードの確認が完了しませんでした。";setError(message);onError?.(message);}
    finally{setBusy(false);}
  }
  if(checkoutState.type==="error")return <p role="alert">{checkoutState.error.message}</p>;
  return <form onSubmit={submit} className="hf-embedded-checkout">
    <PaymentElement options={{layout:"tabs"}}/>
    {error&&<p role="alert" style={{color:"#b91c1c",fontSize:13}}>{error}</p>}
    {complete?<p role="status" style={{color:"#08785b"}}>カードの確認を受け付けました。決済通知の反映を確認しています。</p>:<button type="submit" disabled={disabled||busy||checkoutState.type!=="success"} aria-busy={busy} style={{width:"100%",marginTop:20,padding:"14px 16px",border:0,borderRadius:8,background:disabled||busy?"#d1d5db":"#089e75",color:"white",font: "inherit",fontWeight:600,cursor:disabled||busy?"default":"pointer"}}>{busy?"確認しています…":confirmLabel??(mode==="setup"?"カードを登録して続ける":`${formatMoney(amountMinor??0)}を支払って続ける`)}</button>}
    <p style={{textAlign:"center",fontSize:11,color:"#71717a",margin:"12px 0 0"}}>カード情報はStripeで安全に処理します</p>
  </form>;
}
