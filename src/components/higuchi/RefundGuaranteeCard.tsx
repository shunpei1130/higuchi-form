"use client";
import { useEffect,useState } from "react";
import { Button,Card,InlineNote } from "./ui";
import { formatMoney } from "@/lib/higuchi/money";
import type { GuaranteeSummary } from "@/lib/higuchi/guaranteePolicy";
type Refund={id:string;status:string;note:string};
export const refundStatusLabel=(status:string)=>({requested:"申請受付",reviewing:"確認中",approved:"承認済み・返金処理待ち",rejected:"確認結果をご確認ください",refunded:"全額返金を確認済み"}[status]??status);
export function RefundGuaranteeCard(){
  const [data,setData]=useState<{summary:GuaranteeSummary;request:Refund|null}|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  async function load(){const response=await fetch("/api/higuchi/guarantee",{cache:"no-store"}),result=await response.json();if(!response.ok)throw new Error(result.error??"返金保証の状態を確認できませんでした。");setData(result);}
  useEffect(()=>{void load().catch(e=>setError(e.message));},[]);
  async function submit(){setBusy(true);setError("");try{const response=await fetch("/api/higuchi/guarantee",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}),result=await response.json();if(!response.ok)throw new Error(result.error);await load();}catch(e){setError(e instanceof Error?e.message:"申請できませんでした。");}finally{setBusy(false);}}
  return <Card><h2>初回前払いの返金保証</h2><p className="hf-description">初回前払い後に1,000通を送信し、7日待っても好意的な返信がない場合、初回入金額の全額返金を申請できます。購入後の期限はありません。</p><p className="hf-subtle">資料・見積依頼、関心表明、商談希望、担当者紹介などを好意的な返信として確認します。申請に必要な送信・返信記録を運営者が確認し、Stripeで返金します。無料枠と初回特典は返金後も再取得できません。</p>
    {error&&<InlineNote kind="warning">{error}</InlineNote>}{data?<><div className="hf-row" style={{gap:24,flexWrap:"wrap",margin:"20px 0"}}><div><small>対象の確定送信</small><strong style={{display:"block"}}>{data.summary.sentCount.toLocaleString("ja-JP")} / 1,000通</strong></div><div><small>好意的な返信・予約</small><strong style={{display:"block"}}>{data.summary.positiveReplies}件</strong></div><div><small>返金対象額</small><strong style={{display:"block"}}>{formatMoney(data.summary.refundAmountMinor,data.summary.currency)}</strong></div></div><p className="hf-description">{data.summary.reason}</p>{data.summary.qualifiedAt&&<p className="hf-subtle">判定開始：{new Date(data.summary.qualifiedAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})}</p>}{data.request?<InlineNote>{refundStatusLabel(data.request.status)}{data.request.note&&`：${data.request.note}`}</InlineNote>:<Button onClick={()=>void submit()} busy={busy} disabled={!data.summary.canRequest}>{data.summary.positiveReplies>0?"判定の確認を申請する":"返金保証を申請する"}</Button>}</>:!error&&<p className="hf-subtle">送信・入金記録を確認しています…</p>}
  </Card>;
}
