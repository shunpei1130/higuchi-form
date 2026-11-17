"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, CalendarCheck, Check, ChevronDown, Gift, LayoutGrid, LoaderCircle, Mail, Menu, MessageCircle, Send, Users, X } from "lucide-react";
import { createPreview } from "@/components/preview/api";
import "./marketing.css";

export function MarketingLogo() {
  return <Link className="hf-wordmark" href="/" aria-label="higuchi-form ホーム"><img src="/higuchi-mark.svg" width="23" height="34" alt="" /><span>higuchi-form</span></Link>;
}

/** The reference uses two canvas flow fields, not a photograph or an illustration. */
function FlowField() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let frame = 0;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const paint = (time: number) => {
      const width = canvas.clientWidth, height = canvas.clientHeight;
      const scale = Math.min(devicePixelRatio || 1, 2);
      if (canvas.width !== width * scale || canvas.height !== height * scale) { canvas.width = width * scale; canvas.height = height * scale; }
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, width, height);
      for (const side of [-1, 1]) for (let i = 0; i < 11; i++) {
        const x0 = side < 0 ? -30 : width + 30;
        const x3 = width / 2 + side * 190;
        const y0 = 30 + i * (height - 80) / 10;
        const y3 = height * 0.53 + (i - 5) * 5;
        const x1 = x0 + (x3 - x0) * 0.48, y1 = y0;
        const x2 = x3 - side * 95, y2 = y3;
        context.beginPath(); context.moveTo(x0, y0); context.bezierCurveTo(x1, y1, x2, y2, x3, y3);
        context.strokeStyle = "rgba(90,110,100,.075)"; context.lineWidth = 0.8; context.stroke();
        const t = reduced ? (i * 0.137) % 1 : ((time / 18000 + i * 0.137) % 1);
        const u = 1-t, x = u*u*u*x0+3*u*u*t*x1+3*u*t*t*x2+t*t*t*x3, y = u*u*u*y0+3*u*u*t*y1+3*u*t*t*y2+t*t*t*y3;
        context.fillStyle = i % 3 === 0 ? "rgba(0,185,138,.65)" : "rgba(70,100,80,.18)";
        context.fillRect(x-1.2, y-1.2, 2.4, 2.4);
      }
      if (!reduced) frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    const resize = () => { if (reduced) paint(0); };
    window.addEventListener("resize", resize);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", resize); };
  }, []);
  return <canvas aria-hidden="true" className="hf-flow" ref={ref} />;
}

const examples = [
  { quote: "事業内容を伝えると、顧客像に合った営業キャンペーンができあがります。", name: "顧客像の整理", company: "AIによる事業分析", icon: Users },
  { quote: "一人ひとりの会社や役割に合わせて、最初のメールから追客まで。", name: "個別のアプローチ", company: "営業メールの自動作成", icon: Mail },
  { quote: "「詳しく知りたい」という返信を見つけたら、会話を進めて予約リンクを案内します。", name: "返信から商談へ", company: "自動返信と予約連携", icon: CalendarCheck },
  { quote: "いくら使ったか、どのキャンペーンに反応があるか。ひとつの画面で確認できます。", name: "成果をひと目で", company: "予算と実績の管理", icon: Check },
];

const questions = [
  ["higuchi-formはどのように動きますか？", "会社のWebサイトか事業内容を入力すると、AIが提供価値と顧客像を整理します。顧客リストを接続すると、個別のメール作成、追客、返信対応、予約リンクの案内まで、設定した予算内で進めます。"],
  ["Webサイトがなくても使えますか？", "はい。「Webサイトを持っていません」から、事業内容、理想の顧客、対象地域を入力してください。"],
  ["料金はいくらですか？", "営業メール1通あたり6円。返信対応は無料です。月額契約はなく、日額と月額の上限を設定できます。初回の前払いは4,500円・7,500円・15,000円から選べ、2倍の利用クレジットを付与します。"],
  ["どの国や言語を対象にできますか？", "地域と顧客条件はキャンペーンごとに設定できます。画面と初期のメール言語は日本語です。顧客データの取得先は後から接続でき、現在はCSVの持込みに対応しています。"],
  ["どのメールアドレスから送りますか？", "運営側が設定した専用メールボックスから送信します。本番送信には、メール基盤の接続と認証設定が必要です。検証モードのメールはすべて架空で、外部へ送信しません。"],
  ["いつでも止められますか？", "キャンペーンはいつでも停止・再開できます。停止中は初回メール、追客、自動返信を送信しません。受信した会話は引き続き確認できます。"],
];

export function Landing({previewEnabled=true}:{previewEnabled?:boolean}) {
  const router = useRouter();
  const [website, setWebsite] = useState("");
  const [websiteError, setWebsiteError] = useState("");
  const [menu, setMenu] = useState(false);
  const [products, setProducts] = useState(false);
  const [businessOpen, setBusinessOpen] = useState(false);
  const [business, setBusiness] = useState("");
  const [customer, setCustomer] = useState("");
  const [geo, setGeo] = useState("");
  const [amount, setAmount] = useState(4500);
  const [starting, setStarting] = useState(false);
  const [support, setSupport] = useState(false);
  const [faq, setFaq] = useState<number | null>(null);

  async function beginPreview(input: { website: string; business?: string; customer?: string; geography?: string }) {
    if (starting) return;
    if(!previewEnabled){const query=new URLSearchParams({...(input.website?{website:input.website}:{description:input.business??""}),icp:input.customer??"",geo:input.geography??"日本"});router.push(`/app/onboarding?${query}`);return;}
    setStarting(true); setWebsiteError("");
    try {
      const preview = await createPreview(input);
      const route = input.website ? `/auto-gtm/company/${encodeURIComponent(new URL(input.website).hostname)}/explore` : "/auto-gtm/business/explore";
      router.push(`${route}?run=${encodeURIComponent(preview.id)}&phase=${preview.currentStage || "company"}`);
    } catch (cause) { setWebsiteError(cause instanceof Error ? cause.message : "準備を開始できませんでした。もう一度お試しください。"); setStarting(false); }
  }

  function submitWebsite(event: FormEvent) {
    event.preventDefault();
    try {
      const normalized = /^https?:\/\//i.test(website.trim()) ? website.trim() : `https://${website.trim()}`;
      const url = new URL(normalized);
      if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".") || url.username || url.password) throw new Error();
      void beginPreview({ website: url.href });
    } catch { setWebsiteError("会社のWebサイトを入力してください（例：example.com）。"); }
  }

  function submitBusiness(event: FormEvent) {
    event.preventDefault();
    void beginPreview({ website: "", business, customer, geography: geo });
  }

  return <div className="hf-marketing">
    <header className="hf-nav"><MarketingLogo /><nav className={menu ? "hf-nav-links is-open" : "hf-nav-links"} aria-label="メインナビゲーション">
      <div className="hf-product-menu"><button onClick={()=>setProducts(!products)} aria-expanded={products}><LayoutGrid size={16}/>サービス<ChevronDown size={13}/></button>{products && <div className="hf-product-dropdown"><a href="#hf-website" onClick={()=>{setProducts(false);setMenu(false);document.getElementById("hf-website")?.focus();}}><Mail size={19}/><span>AI営業エージェント<small>事業を伝えて、次の商談へ</small></span></a><Link href="/info/data"><Users size={19}/><span>顧客データ<small>DB・Excelの取り込みに対応</small></span></Link></div>}</div>
      <a href="#pricing" onClick={()=>setMenu(false)}>料金</a><Link href="/info/affiliate">紹介プログラム</Link><Link href="/sign-in">ログイン</Link>
    </nav><button className="hf-menu-toggle" aria-label={menu?"メニューを閉じる":"メニューを開く"} aria-expanded={menu} onClick={()=>setMenu(!menu)}>{menu?<X/>:<Menu/>}</button></header>

    <main>
      <section className="hf-hero"><FlowField/><div className="hf-hero-content">
        <div className="hf-proof-pill"><span className="hf-status-dot"/>あなたの代わりに、営業を進めるAI</div>
        <h1><span>次のホットリードを</span><br/>24時間、探し続ける。</h1>
        <div className="hf-credit"><Gift size={16}/>4,500円分の無料クレジット</div>
        <form className="hf-website-form" onSubmit={submitWebsite}><label className="hf-sr-only" htmlFor="hf-website">会社のWebサイト</label><input id="hf-website" value={website} onChange={e=>{setWebsite(e.target.value);setWebsiteError("");}} placeholder="会社のWebサイト（例：example.com）" autoComplete="url" disabled={starting} aria-describedby={websiteError?"hf-url-error":undefined}/><button disabled={!website.trim()||starting} aria-label={starting?"営業の準備を開始しています":"見込み客を探す"}><span>{starting?"準備を開始しています":"見込み客を探す"}</span>{starting?<LoaderCircle size={20} className="hf-start-spinner"/>:<ArrowRight size={20}/>}</button></form>
        {websiteError && <p id="hf-url-error" className="hf-form-error" role="alert">{websiteError}</p>}
        <button className="hf-no-website" onClick={()=>setBusinessOpen(true)}>Webサイトを持っていません</button>
        <p className="hf-hero-description">市場を調べ、顧客像を整理し、相手に合わせたメールを。<br className="hf-desktop-break"/>AIが返信に対応して、次の商談につなげます。</p>
      </div></section>

      <section className="hf-examples" aria-labelledby="hf-example-title"><h2 id="hf-example-title">営業の手間を、ひとつずつ。</h2><div className="hf-example-track">{examples.map(item=><article key={item.name} className="hf-example-card"><p>“{item.quote}”</p><div><span className="hf-example-icon"><item.icon size={19}/></span><span><strong>{item.name}</strong><small>{item.company}</small></span></div></article>)}</div></section>

      <section id="how-it-works" className="hf-how"><div className="hf-section-title"><span>ひとつの流れで</span><h2>最初の一通から、<br/>商談のきっかけまで。</h2></div><div className="hf-step-grid">
        <article><span className="hf-step-num">01</span><h3>あなたの事業を理解する</h3><p>Webサイトや事業の説明から、提供価値と選ばれる理由を整理します。</p><div className="hf-analysis-example"><span>事業の分析</span><strong>誰の、どんな課題を解決するか</strong><div><Check size={14}/>提供価値と強み</div><div><Check size={14}/>理想の顧客と地域</div><div><Check size={14}/>アプローチの方針</div></div></article>
        <article><span className="hf-step-num">02</span><h3>一人ひとりに届ける</h3><p>相手の事業や役割を踏まえて、個別の文面と追客の流れを作ります。</p><div className="hf-email-example"><div><Mail size={16}/><span>メールのプレビュー</span></div><strong>御社の営業活動について</strong><p>事業を拝見し、お力になれることがあると考え、ご連絡しました。<br/><br/>まずは短いお打ち合わせで、ご紹介できれば幸いです。</p><small>サンプルの文面です</small></div></article>
        <article><span className="hf-step-num">03</span><h3>会話を進め、商談へ</h3><p>興味のある返信を見つけて対応。予約リンクを案内し、その後の状況も追跡します。</p><div className="hf-chat-example"><p>もう少し詳しく聞かせてもらえますか？</p><p>ありがとうございます。こちらからご都合のよい日時をお選びください。</p><span><CalendarCheck size={14}/>予約結果を管理画面に反映</span></div></article>
      </div></section>

      <section className="hf-benefits"><h2>営業に必要なことを、<br className="hf-mobile-break"/>シンプルに。</h2><div><article><strong>24<span>/7</span></strong><h3>設定した条件で自動運転</h3><p>キャンペーンも返信も、ひとつの画面で管理。</p></article><article><strong>あなた専用</strong><h3>運営側のメール基盤</h3><p>顧客組織ごとに送信元を分けて管理します。</p></article><article><strong>6円<span> / 通</span></strong><h3>使った分だけのお支払い</h3><p>営業メールの送信に応じた従量課金。</p></article></div></section>

      <section id="pricing" className="hf-pricing"><h2>月額契約なし。<br/>使った分だけ。</h2><div className="hf-price-card"><label htmlFor="hf-price-slider" className="hf-price-amount">{amount.toLocaleString("ja-JP")}円</label><input id="hf-price-slider" type="range" min="1500" max="75000" step="1500" value={amount} onChange={e=>setAmount(Number(e.target.value))} aria-label="利用額の試算（円）"/><div className="hf-price-scale"><span>1,500円</span><span>75,000円</span></div><div className="hf-price-stats"><div><Send/><strong>{Math.floor(amount/6).toLocaleString("ja-JP")}</strong><span>営業メール</span></div><div><Users/><strong>~{Math.max(1,Math.round(amount/2250))}–{Math.round(amount/750)}</strong><span>有望な返信</span></div><div><CalendarCheck/><strong>~{Math.max(1,Math.round(amount/4500))}</strong><span>商談</span></div><div><MessageCircle/><strong>150–3,000円</strong><span>見込み客あたり</span></div></div><p className="hf-estimate-note">返信・商談数は参考値です。成果を保証するものではありません。</p><a href="#hf-website" className="hf-primary" onClick={()=>document.getElementById("hf-website")?.focus()}>4,500円分を試してみる<ArrowRight size={18}/></a><small>従量払いはカード確認後に無料枠を付与。初回前払い2倍との併用はできません。</small><p className="hf-refund-note">前払いは4,500円・7,500円・15,000円から。初回前払い後に1,000通送り、7日経っても好意的な返信がなければ、初回入金の全額返金を申請できます。<Link href="/info/terms">返金条件を確認</Link></p></div></section>

      <section className="hf-faq"><h2>よくある質問</h2>{questions.map(([q,a],i)=><div key={q} className="hf-faq-item"><button onClick={()=>setFaq(faq===i?null:i)} aria-expanded={faq===i} aria-controls={`hf-faq-${i}`}>{q}<ChevronDown size={18} className={faq===i?"rotated":""}/></button><div id={`hf-faq-${i}`} hidden={faq!==i}><p>{a}</p></div></div>)}</section>

      <section className="hf-last-cta"><h2>次のお客様との会話を、<br/>ここから。</h2><a className="hf-primary" href="#hf-website" onClick={()=>document.getElementById("hf-website")?.focus()}>無料で始める<ArrowRight size={18}/></a></section>
    </main>

    <footer className="hf-footer"><div className="hf-footer-columns"><div><h4>サービスと営業ツール</h4><Link href="/app/onboarding">AI営業エージェント</Link><Link href="/info/data">企業データベース</Link><Link href="/app/leads">顧客リストの取り込み</Link></div><div><h4>顧客データ</h4><Link href="/info/data">日本の企業</Link><Link href="/info/data">北米・ヨーロッパの企業</Link><Link href="/info/data">アジア太平洋の企業</Link></div><div><h4>リソース</h4><a href="#pricing">料金</a><Link href="/info/affiliate">紹介プログラム</Link><Link href="/info/api">APIについて</Link><Link href="/info/support">サポート</Link></div><div><h4>higuchi-form</h4><Link href="/app">管理画面</Link><Link href="/info/privacy">プライバシー</Link><Link href="/info/terms">利用について</Link><Link href="/info/company">運営会社</Link></div></div><div className="hf-footer-bottom"><span>© {new Date().getFullYear()} MAORA株式会社 / higuchi-form</span><span><Link href="/info/terms">利用について</Link><span> · </span><Link href="/info/privacy">プライバシー</Link></span></div><p className="hf-footer-note">運営: MAORA株式会社　お問い合わせ: <a href="mailto:shumpei.hasegawa@maora.co.jp">shumpei.hasegawa@maora.co.jp</a><br/>顧客データの取得先は準備中です。検証モードでは架空データを使用し、実際のメール送信・請求は行いません。</p></footer>

    <Dialog.Root open={businessOpen} onOpenChange={setBusinessOpen}><Dialog.Portal><Dialog.Overlay className="hf-dialog-overlay"/><Dialog.Content className="hf-dialog"><Dialog.Title>あなたの事業について</Dialog.Title><Dialog.Description>入力した内容から、営業キャンペーンを作ります。</Dialog.Description><form onSubmit={submitBusiness}><label>何を提供していますか？<textarea autoFocus required maxLength={5000} value={business} disabled={starting} onChange={e=>setBusiness(e.target.value)} placeholder="例：B2B営業チーム向けのメール作成AI"/></label><label>理想のお客様は？<textarea required maxLength={2000} value={customer} disabled={starting} onChange={e=>setCustomer(e.target.value)} placeholder="例：成長中のSaaS企業の経営者、営業責任者"/></label><label>対象の市場や地域は？<input required maxLength={300} value={geo} disabled={starting} onChange={e=>setGeo(e.target.value)} placeholder="例：日本、東京都・大阪府"/></label>{websiteError&&<p className="hf-form-error" role="alert">{websiteError}</p>}<button className="hf-primary" disabled={starting||!business.trim()||!customer.trim()||!geo.trim()}>{starting?<LoaderCircle size={18} className="hf-start-spinner"/>:"キャンペーンを作成する"}{!starting&&<ArrowRight size={18}/>}</button></form><Dialog.Close className="hf-dialog-close" aria-label="閉じる"><X size={22}/></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
    <button className="hf-support-fab" aria-label="サポートを開く" aria-expanded={support} onClick={()=>setSupport(!support)}>{support?<X size={23}/>:<MessageCircle size={25}/>}</button>{support && <aside className="hf-support-panel"><h3>お手伝いします</h3><p>設定や使い方で迷ったときは、サポートページをご確認ください。</p><Link href="/info/support">サポートを見る<ArrowRight size={16}/></Link></aside>}
  </div>;
}
