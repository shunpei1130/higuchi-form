"use client";
import Link from "next/link";
import { useEffect,useState,type FormEvent } from "react";
import { Button, Card, InlineNote } from "@/components/higuchi/ui";
import "@/components/higuchi/workspace.css";
type Dataset={id:string;name:string;source:string;published:boolean;rowCount:number;createdAt:string};
export function ProspectLibrary(){
  const [datasets,setDatasets]=useState<Dataset[]>([]),[name,setName]=useState(""),[file,setFile]=useState<File|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[error,setError]=useState("");
  async function refresh(){const response=await fetch("/api/higuchi/operator/catalog",{cache:"no-store"}),result=await response.json();if(!response.ok)throw new Error(result.error??"データを取得できませんでした。");setDatasets(result.datasets);}
  useEffect(()=>{void refresh().catch(e=>setError(e.message));},[]);
  async function submit(event:FormEvent){event.preventDefault();if(!file)return;setBusy(true);setError("");setMessage("");try{
    const body=new FormData();body.set("file",file);body.set("name",name||file.name);
    const response=await fetch("/api/higuchi/operator/catalog",{method:"POST",body}),result=await response.json();if(!response.ok)throw new Error(result.error??"取り込めませんでした。");
    setMessage(`${result.rowCount.toLocaleString("ja-JP")}件を非公開で取り込みました。内容を確認し、試用画面で使用するデータだけ公開してください。`);await refresh();
  }catch(e){setError(e instanceof Error?e.message:"取り込めませんでした。");}finally{setBusy(false);}}
  async function publish(dataset:Dataset){setBusy(true);setError("");try{const response=await fetch("/api/higuchi/operator/catalog",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"publish",datasetId:dataset.id,published:!dataset.published})}),result=await response.json();if(!response.ok)throw new Error(result.error);setMessage(dataset.published?"試用画面への公開を停止しました。":"試用画面の検索対象に追加しました。新しい調査から使用されます。");await refresh();}catch(e){setError(e instanceof Error?e.message:"更新できませんでした。");}finally{setBusy(false);}}
  const template="会社名,ドメイン,事業内容,所在地,従業員数,氏名,役職,メールアドレス,検証状態,出典URL\n";
  return <main className="hf-workspace" style={{maxWidth:1100,margin:"0 auto",padding:"40px 24px"}}><Link href="/operator" className="hf-back">← 接続設定に戻る</Link><h1>試用画面の顧客データ</h1><p className="hf-description">DBの書き出しやExcelから候補を取り込みます。各ワークスペースの非公開CRMとは別の、運営者が管理するデータです。</p>
    {error&&<InlineNote kind="warning">{error}</InlineNote>}{message&&<InlineNote>{message}</InlineNote>}
    <Card><h2>CSV・Excelを取り込む</h2><form onSubmit={submit} className="hf-form"><div className="hf-field"><label htmlFor="catalog-name">データ名</label><input id="catalog-name" value={name} maxLength={150} onChange={e=>setName(e.target.value)} placeholder="例：日本の企業・担当者"/></div><div className="hf-field"><label htmlFor="catalog-file">ファイル</label><input id="catalog-file" type="file" accept=".csv,.xlsx" required onChange={e=>setFile(e.target.files?.[0]??null)}/><small>5MB・10,000行まで。Excelは最初のシートを読み込みます。</small></div><Button type="submit" busy={busy} disabled={!file}>非公開で取り込む</Button></form>
      <p className="hf-subtle">必須列は会社名です。ドメイン・事業内容・所在地・担当者・役職・メール・検証状態・出典URLを追加できます。検証状態がないメールは「未確認」として保存します。</p><a className="hf-back" download="higuchi-prospects-template.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent("\uFEFF"+template)}`}>CSVの見出しテンプレート</a>
      <details style={{marginTop:18}}><summary>DBから取り込む場合</summary><p className="hf-subtle">同じ見出しでCSVへ書き出して取り込めます。連携用APIは、この画面と同じ運営者の認証が必要です。</p><code>POST /api/higuchi/operator/catalog</code><pre style={{fontSize:12,whiteSpace:"pre-wrap"}}>{JSON.stringify({action:"import",name:"顧客DB",rows:[{"会社名":"会社名","ドメイン":"company.example","氏名":"担当者名"}]},null,2)}</pre></details>
    </Card><Card><h2>取り込み済みデータ</h2><InlineNote>公開したデータは、ログイン前の訪問者にも候補として表示されます。試用画面に出してよい情報だけを公開してください。</InlineNote>{!datasets.length?<p className="hf-description">まだデータはありません。公開の試用画面では、架空のサンプルを表示します。</p>:<div className="hf-stack">{datasets.map(dataset=><article key={dataset.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:16,borderBottom:"1px solid #eee",padding:"16px 0"}}><div><strong>{dataset.name}</strong><p className="hf-subtle">{dataset.rowCount.toLocaleString("ja-JP")}件 · {dataset.source.toUpperCase()} · {new Date(dataset.createdAt).toLocaleDateString("ja-JP")} · {dataset.published?"試用画面で使用中":"非公開"}</p></div><Button variant="secondary" busy={busy} onClick={()=>void publish(dataset)}>{dataset.published?"公開を停止":"試用画面で使用する"}</Button></article>)}</div>}</Card></main>;
}
