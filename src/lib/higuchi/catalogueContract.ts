import { createHash } from "node:crypto";
import { ProductError } from "./state";

export type CatalogVerification="valid"|"invalid"|"catch_all"|"unknown";
export type CatalogRecord={externalKey:string;companyName:string;domain:string;description:string;location:string;employeeCount:number|null;monthlyTraffic:number|null;trafficGrowth:number|null;name:string;role:string;email:string;verification:CatalogVerification;sourceUrl:string;extra:Record<string,string>};
export type CatalogCompany={id:string;name:string;domain:string;description:string;location:string;employeeCount:number|null;monthlyTraffic:number|null;trafficGrowth:number|null;sourceUrl:string};
export type CatalogPerson={id:string;companyId:string;name:string;role:string;email:string;verification:CatalogVerification;location:string;sourceUrl:string;sourceLabel:string};
const clean=(value:unknown,max=1000)=>String(value??"").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,"").trim().slice(0,max);
const header=(value:string)=>value.toLowerCase().replace(/[\s_\-　]/g,"");
export function catalogCompanyId(domain:string,name:string):string{return `company_${createHash("sha256").update((domain||name).toLowerCase()).digest("hex").slice(0,24)}`;}
export function publicCatalogUrl(value:unknown):string{
  const raw=clean(value,2000);if(!raw)return "";
  try{const url=new URL(/^https?:\/\//i.test(raw)?raw:`https://${raw}`);if(!["http:","https:"].includes(url.protocol)||url.username||url.password)return "";url.hash="";return url.href;}catch{return "";}
}
/** Canonical import contract shared by CSV, Excel and database exports. No formulas are executed. */
export function normalizeCatalogRows(rows:Record<string,unknown>[]):CatalogRecord[]{
  if(!Array.isArray(rows)||!rows.length||rows.length>10000)throw new ProductError("データは1〜10,000行で指定してください。");
  const result=new Map<string,CatalogRecord>();
  rows.forEach((row,index)=>{
    const values=new Map(Object.entries(row).map(([key,value])=>[header(key),value]));
    const get=(...keys:string[])=>{for(const key of keys){const value=values.get(header(key));if(value!==undefined&&value!==null&&value!=="")return value;}return "";};
    const companyName=clean(get("company","company_name","companyName","会社名","企業名","会社"),300);
    if(!companyName)throw new ProductError(`${index+2}行目の会社名を指定してください。`);
    const website=publicCatalogUrl(get("domain","website","url","ドメイン","Webサイト","会社URL"));
    const domain=website?new URL(website).hostname.replace(/^www\./,"").toLowerCase():"";
    const email=String(get("email","email_address","メール","メールアドレス")).trim().toLowerCase();
    if(email&&(email.length>254||! /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)))throw new ProductError(`${index+2}行目のメールアドレスを確認してください。`);
    const name=clean(get("name","full_name","person","氏名","名前","担当者"),200);
    const state=clean(get("verification","email_status","検証状態","メール検証"),30).toLowerCase();
    const verification:CatalogVerification=["valid","verified","検証済み","有効"].includes(state)?"valid":["invalid","無効","送信不可"].includes(state)?"invalid":["catch_all","catchall"].includes(state)?"catch_all":"unknown";
    const number=(...keys:string[])=>{const raw=clean(get(...keys),30).replace(/[,，%％]/g,"");if(!raw)return null;const n=Number(raw);return Number.isSafeInteger(n)&&Math.abs(n)<=2_000_000_000?n:null;};
    const externalKey=createHash("sha256").update([domain||companyName,email||name||"company-only"].join("\n")).digest("hex");
    const extra:Record<string,string>={};for(const [key,value]of Object.entries(row).slice(0,60)){const safeKey=clean(key,100);if(!["__proto__","constructor","prototype"].includes(safeKey))extra[safeKey]=clean(value,2000);}
    result.set(externalKey,{externalKey,companyName,domain,description:clean(get("description","business","会社概要","事業内容","説明"),4000),location:clean(get("location","region","country","地域","所在地","国"),300),employeeCount:number("employee_count","employees","従業員数","企業規模"),monthlyTraffic:number("monthly_traffic","traffic","月間アクセス数"),trafficGrowth:number("traffic_growth","growth","アクセス増減率"),name,role:clean(get("role","job_title","title","役職"),200),email,verification,sourceUrl:publicCatalogUrl(get("source_url","出典URL","出典"))||website,extra});
  });
  return [...result.values()];
}
/** Bounded RFC4180 reader; aliases and extra columns are retained by the normalizer. */
export function catalogCsvRows(input:string):Record<string,string>[] {
  if(Buffer.byteLength(input,"utf8")>5_000_000)throw new ProductError("CSVは5MB以内で指定してください。");
  const table:string[][]=[];let row:string[]=[],cell="",quoted=false;
  const text=input.replace(/^\uFEFF/,"");
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(!cell||quoted)quoted=!quoted;else throw new ProductError("CSVの引用符を確認してください。");}else if(c===","&&!quoted){row.push(cell);cell="";}else if((c==="\n"||c==="\r")&&!quoted){if(c==="\r"&&text[i+1]==="\n")i++;row.push(cell);if(row.some(s=>s.trim()))table.push(row);row=[];cell="";if(table.length>10001)throw new ProductError("一度に取り込める件数は10,000件です。");}else cell+=c;}
  if(quoted)throw new ProductError("CSVの引用符が閉じられていません。");row.push(cell);if(row.some(s=>s.trim()))table.push(row);
  if(table.length<2)throw new ProductError("見出しとデータを指定してください。");
  const headers=table[0].map(s=>s.trim());if(headers.length>60||new Set(headers.map(header)).size!==headers.length)throw new ProductError("見出しは重複しない60列以内で指定してください。");
  return table.slice(1).map(r=>Object.fromEntries(headers.map((key,i)=>[key,r[i]??""])));
}
