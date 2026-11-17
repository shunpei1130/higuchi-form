# Expleeの調査とhiguchi-formへの対応

## 確認した範囲

2026年11月16〜17日に[Expleeの公開ページ](https://explee.com/)、ログイン前のURL入力からメール確認・プラン選択まで、PCとスマートフォンの表示を確認した。[公開API仕様](https://api.explee.com/public/api/docs)と[OpenAPI](https://api.explee.com/public/api/openapi.json)は、キャンペーン、受信箱、予算などの業務仕様を確認するために参照した。

URL入力後は、会社調査、競合調査、キャンペーン設計、企業候補、意思決定者、個別メールの6工程が進む。会社・競合・キャンペーンの左欄、企業・担当者・メールの切り替え、メールの編集、最終の前払い／従量払い選択は公開画面で観察した。非公開のコード、モデル、顧客データ、ログイン後の管理画面、実際の獲得成果は確認していない。

基盤は[Kandid-ai/AgentSDR](https://github.com/Kandid-ai/AgentSDR/tree/263888cbfb127787b002b6be0c432e85765ead90)の固定コミット`263888cbfb127787b002b6be0c432e85765ead90`。上流のMIT著作権・許諾表示は[LICENSE](../LICENSE)に保持している。以下はhiguchi-formが採用した実装であり、Expleeの内部構成を推定したものではない。

## 現在の実装

| 工程 | higuchi-formの処理 | 主なモジュール |
| --- | --- | --- |
| 公開入力・会社調査 | URLまたは事業・顧客像・地域から匿名調査を保存。公開ページを読み、OpenAI `gpt-6-luna`で事業を整理する | `preview/store.ts`、`preview/research.ts`、`preview/ai.ts` |
| 競合調査 | 合計3回までのWeb検索から、出典を確認できた最大15社を表示する | `preview/research.ts`、`preview/budget.ts` |
| キャンペーン | 異なる顧客像の企画を3〜6つ作成。短い日英検索語、地域、役職、会社規模を保存。検索語と人数範囲を個別に編集する | `preview/types.ts`、`preview/rules.ts` |
| 顧客候補 | 運営者が公開したDB出力・CSV・Excelから条件で絞り込み、提供元の検証状態を表示する | `prospectCatalog.ts`、`prospectFilters.ts`、`catalogueContract.ts` |
| 個別メール | 全キャンペーンに配分した最大9通を作成。宛先・件名・本文を版付きで編集し、途中の入力を進捗更新で上書きしない | `preview/research.ts`、`src/components/preview/` |
| 本人確認・取り込み | 画面内OTP後、同じ匿名結果を組織へ一度だけ保存。取り込み時点では送信予約や自動開始を作らない | `previewClaim.ts`、`previewClaimContract.ts` |
| 決済・開始 | 円建てStripe Payment Element、明示した開始承認、当該セッションの署名付き通知、保存文面を照合して開始する | `providerBilling.ts`、`billingState.ts`、`src/components/higuchi/EmbeddedCheckout.tsx` |
| 送信・利用確定 | 予算と送信条件を確認し、Googleの受付記録後に送信・利用量を確定。結果不明は照合し、無条件に再送しない | `delivery.ts`、`providerMailboxes.ts`、`jobs/handlers.ts` |
| 返信・商談 | 受信に応じて追客を取り消し、配信停止・要確認を優先。顧客別の内蔵予約ページで予約・変更・取消を管理する | `analysis.ts`、`jobs/inboxRules.ts`、`booking/` |
| 利用量・返金保証 | Stripe Meters・Credit Grants・Subscriptionsとアプリ台帳を照合し、保証申請を運営者が審査する | `providerBilling.ts`、`money.ts`、`guaranteePolicy.ts` |

モジュール名は断りのない限り`src/lib/higuchi/`内を指す。公開画面は`/auto-gtm/.../explore`と`/api/previews`、管理画面は`/app`、画面向けAPIは`/api/higuchi/workspace`と`/api/higuchi/actions`である。Explee APIとの完全互換は目的としていない。

## 運用上の判断

- UIと文面の既定は日本語。新しい利用は円建てで1通6円、返信は無料。無料枠4,500円と初回前払い2倍は併用しない。既存USD顧客・契約は自動換算せず保持する。
- OpenAIは直接接続し、匿名調査を含むアプリ全体でUTC月額20米ドルまで予約・精算する。AIには送信・課金・設定変更の権限を渡さない。
- 営業送信元はGoogle OAuthで接続した`shumpei.hasegawa@maora.co.jp`。現在の運用上限は対象組織ごとに1日30通、日本時間の平日10〜18時。通知・認証メールはResendで扱う。
- 予約は内蔵機能を使用する。既定は日本時間の平日10〜18時、30分、15分刻み、終了後15分の余白、24時間前から30日先まで。外部カレンダー同期や会議URLの自動生成はしない。
- 決済・従量課金はStripeへ直接接続する。MetronomeやOpenRouter、Cal.comは今回の営業フローの実接続先に使わない。
- 匿名の会社情報・候補・文面は保存期限を24時間とし、期限後の定期処理で消去する。費用台帳と、本人確認後に組織へ取り込んだデータは保持する。公開停止用の`HIGUCHI_PUBLIC_PREVIEW=false`では、LPを従来のログイン後の事業設定へ戻す。

## データと確認の限界

顧客データは利用者が後から用意する。運営者が公開したライブラリだけを匿名検索し、非公開データや各組織の私有顧客リストを検索対象にしない。外部顧客データサービスやExplee APIの契約は追加しない。

データが未公開なら候補とメールをサンプルと明記し、取り込み・カード登録・決済・送信を禁止する。公開済みデータに該当候補がなければ0件を表示する。会社・競合も固定データにする画面検証用の機能は、専用のテスト環境だけで使える。

Expleeの顧客写真・推薦文・成果値はhiguchi-formの実績として使っていない。素材は[出典](../public/reference-assets.md)、接続と設定は[運用手順](higuchi-integrations.md)、実接続の確認範囲は[本番状況](higuchi-production-status.md)を参照されたい。模擬試験や接続表示の成功だけでは、実送信・実課金・通知配送の一連の動作を確認済みとは扱わない。
