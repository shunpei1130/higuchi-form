# higuchi-formの接続・運用手順

公開先は **https://form-higuchi.vercel.app** です。AgentSDRを基盤にした独立実装で、Expleeの非公開コード、企業データベース、配信設備は含みません。実データは後から用意するDB出力・CSV・Excelを運営者が公開します。新しい外部顧客データサービスとの契約は不要です。

## 現在の構成と確認範囲

| 機能 | 接続先・管理方法 |
| --- | --- |
| 会社分析・営業文面・返信案 | OpenAI APIへ直接接続。`gpt-6-luna`のみ使用 |
| 営業メールの送受信 | Google OAuthで`shumpei.hasegawa@maora.co.jp`本人を接続 |
| 認証メール・サービス通知 | Resend。Fromは`noreply@kodama.maora.co.jp`、Reply-Toは`s.hasegawa1130@gmail.com` |
| 商談予約 | 内蔵の予約ページ。`/app/settings`で受付時間を設定 |
| 決済・従量課金 | Stripeの専用商品・メーター・料金・顧客・契約 |
| 自動処理 | PostgreSQLの永続キューと、Vercel Productionの1分ごとの定期呼び出し |

`HIGUCHI_MODE=simulation`を明示したローカル環境では架空データを使い、外部AI、メール、決済を呼びません。省略時も含め、それ以外は`live`です。実接続モードでは未設定をエラーにし、模擬成功で補いません。Vercel PreviewではAIの実呼び出しと営業メールの実送信を停止します。

2026年11月17日時点で、本番・検証用Neonデータベース、Resendの通知専用キー・配送Webhook、本番環境の秘密情報を設定済みです。Google OAuthで`shumpei.hasegawa@maora.co.jp`を接続し、内蔵予約の受付を承認済みの条件で公開しました。StripeはLIVEの制限付きキー・専用料金設定・13種類のイベントを受ける署名付きWebhookを登録済みです。運営画面でAI・営業メール・予約・決済の4項目が設定済みと表示されることを確認しました。

ResendのOTPメールの実配送とログイン、専用Stripe TESTモードのAPI試験は成功しました。予約とジョブの同時実行・重複排除は検証用PostgreSQLで確認済みです。営業メールの実送受信、予約通知の実配送、LIVEの実課金、有効な決済通知がアプリへ届いて状態を反映する一連の試験は未実施です。

## 1. 公開先・データベース・秘密情報

Vercelの対象は`form-higuchi`です。Productionへ設定し、Previewへ本番用の秘密情報を配布しないでください。

| 環境変数 | 内容 |
| --- | --- |
| `HIGUCHI_MODE` | 本番は`live`。ローカルの模擬確認だけ`simulation` |
| `AUTH_SIGNUP` | 公開サービスは`open`。メール確認後に個人ワークスペースを作成する。コードの既定は`invite-only` |
| `HIGUCHI_PUBLIC_PREVIEW` | 準備中は`false`。匿名調査のAPIとworkerを止め、LPはログイン後の事業設定へ進む。公開準備後に`true` |
| `BETTER_AUTH_URL`・`NEXT_PUBLIC_APP_URL` | `https://form-higuchi.vercel.app` |
| `DATABASE_URL` | 本番PostgreSQL。実行時は接続プールを利用可能 |
| `DATABASE_URL_UNPOOLED` | スキーマ更新用の直接接続先 |
| `BETTER_AUTH_SECRET` | セッション署名用のランダムな秘密値 |
| `INTEGRATION_CREDENTIALS_KEY` | 保存するOAuth認証情報・通知本文などの暗号化キー。安全に保管し、無計画に変更しない |
| `UNSUBSCRIBE_SECRET` | 営業メールの配信停止リンク用 |
| `BOOKING_TOKEN_SECRET` | 予約・変更リンク用。ランダムな32文字以上の秘密値 |
| `CRON_SECRET` | 定期呼び出しを認証する十分に長いランダムな秘密値 |
| `HIGUCHI_SEND_ENABLED` | 初期設定・決済確認中は`false`。合意済みの送信テストを始めるときに`true` |

既存データベースはバックアップを取得してから、次の追加スキーマを適用します。`--check`は接続しない静的確認です。適用時は直接接続が必要です。新しい空のデータベースには先に`bun run db:setup`で基本スキーマを作成します。既存データベースへ全体の初期化処理を実行しないでください。

```sh
bun scripts/db/higuchi-setup.ts --check
bun scripts/db/higuchi-preview.ts --check
bun scripts/db/higuchi-catalog-guarantee.ts --check
bun scripts/db/higuchi-setup.ts
bun scripts/db/higuchi-preview.ts
bun scripts/db/higuchi-catalog-guarantee.ts
```

キーをチャット、ソース、Git、コマンド引数へ貼り付けないでください。ファイルで渡す場合はリポジトリ外の本人だけが読める場所に保存します。例は`C:\Users\<ユーザー名>\.config\higuchi-form\stripe-test-key.txt`です。内容の表示やログ出力は行いません。公開先への登録は非公開ファイルからメモリへ読み取り、標準入力を通じてVercelの機密環境変数へ渡します。実際のキーをこの文書や`.env.example`へ保存しないでください。

## 2. 運営者画面と組織対応

https://form-higuchi.vercel.app/operator を、初期の運営ワークスペースのownerまたはadminで開き、対象組織を名前で選びます。シミュレーションでは説明の確認だけができ、外部接続の保存はできません。

運営者APIは認証・運営権限を検査し、POSTでは同一オリジンも確認します。

| 操作 | 応答・入力 |
| --- | --- |
| `GET /api/higuchi/admin` | `{ organizations: [{ id, name }] }` |
| `GET /api/higuchi/admin?organizationId=<UUID>` | `{ mailboxes, integrations, aiBudget }`。秘密キーやトークンは返さない |
| `POST /api/higuchi/admin` | `{ "action": "billing.save", "organizationId": "<UUID>", "credentials": { "stripeCustomerId": "cus_...", "stripeSubscriptionId": "sub_..." } }` |

`billing.save`は顧客・契約のIDだけを受け付けます。運営用のStripeキーは送れません。通常は最初のカード登録・前払いで専用顧客を自動作成するため、ID入力は不要です。既存IDは同じ組織・環境のhiguchi-form専用であることと、顧客・契約・料金の対応を照合します。他サービスの顧客は流用できません。旧形式の課金接続は運営者が照合して再接続します。

## 3. OpenAI

本番に`OPENAI_API_KEY`、`HIGUCHI_OPENAI_MODEL=gpt-6-luna`、`HIGUCHI_AI_MONTHLY_USD=20`を設定します。予算は組織ごとではなく、**全組織を合計してUTCの各月20米ドルまで**です。20米ドルを超える設定にはできません。実行前にデータベースの共通ロック下で予算を予約し、応答の使用量で精算します。結果が不明な呼び出しは予約を残します。OpenAI側の残高・利用制限も別途有効です。対応料金を確認していない別モデルへの切り替えは拒否します。

会社サイトは公開HTTP/HTTPSの標準ポートから取得し、内部ネットワーク・メタデータ宛てを拒否します。DNS検査済みのIPへ接続を固定し、転送先も検査します。取得量と解析用テキストには上限があります。

サイト本文・受信メールは信頼できない資料として扱い、AIには外部操作のツールを渡しません。構造化された分析・文面だけを受け取り、確認できない成果や企業データの保有を主張させません。会社分析は永続キューへ登録されます。

## 4. 営業メールのGoogle OAuth

営業メールは **`shumpei.hasegawa@maora.co.jp`** から送ります。Google CloudでGmail APIを利用できるWebアプリ用OAuthクライアントを用意し、`GOOGLE_MAIL_CLIENT_ID`・`GOOGLE_MAIL_CLIENT_SECRET`を公開先へ設定します。

承認済みリダイレクトURIは次の完全なURLです。現在のコードでは本番URLに固定されています。

```text
https://form-higuchi.vercel.app/api/higuchi/mail/callback
```

必要な権限は`https://www.googleapis.com/auth/gmail.send`と`https://www.googleapis.com/auth/gmail.readonly`です。運営者画面で対象組織のGoogleメール接続を始め、指定アドレスを選び、両方の権限を許可します。Google側で利用者・組織管理者の承認が必要な場合は完了させてください。別アドレスは接続できません。更新トークンは組織別に暗号化して保存します。

ログイン用の`GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`とは別設定です。サービスアカウントのJSONやドメイン全体の委任は使いません。メール接続APIは`GET /api/higuchi/mail?organizationId=<UUID>`、同じパスへのPOST `{ "action": "connect" または "disconnect", "organizationId": "<UUID>" }`です。

受信同期は、このアプリから開始した会話のGmailスレッドと既知の相手に限定します。受信箱全体は取り込みません。返信は元の会話へ関連付け、配信停止要求を検出すると以後の送信を止めます。

実送信には`HIGUCHI_SEND_ENABLED=true`が必要です。現行の送信時間は日本時間の平日10〜18時、上限は対象組織の1日30通です。予算・配信停止・キャンペーン状態の条件も検査します。SPF・DKIM・DMARCと到達性は運営側で確認してください。OAuth接続だけで送信元の準備が完了するわけではありません。

送信前に固定の送信IDと本文のハッシュを保存します。受付結果が不明な送信は自動再送せず、Gmailの送信済みにある固定Message-IDで照合します。宛先・文面を変えた同じ送信IDの再利用も拒否します。

## 5. 認証メール・通知のResend

Resendは認証メール、予約の確定・変更・取消などの通知に使います。営業メールの送受信には使いません。`RESEND_API_KEY`・`RESEND_WEBHOOK_SECRET`を設定し、`kodama.maora.co.jp`の送信ドメインを認証してください。

Fromはコードの固定値`higuchi-form <noreply@kodama.maora.co.jp>`、Reply-Toは`s.hasegawa1130@gmail.com`です。GmailアドレスをFromには使いません。新しい通知処理のFromは既存の`AUTH_EMAIL_FROM`では変更されません。APIキーにはこのドメインで通知を送れる権限が必要です。

配信結果の共通通知先は次です。

```text
https://form-higuchi.vercel.app/api/higuchi/mail/resend/webhook
```

イベントは`email.sent`、`email.delivered`、`email.bounced`、`email.complained`、`email.failed`、`email.suppressed`、`email.delivery_delayed`を登録します。通知先の署名シークレットを`RESEND_WEBHOOK_SECRET`へ設定します。受信メール用の通知先ではありません。署名・時刻を検査し、既知の通知IDだけに結果を反映します。

通知本文は暗号化して永続キューへ保存します。認証メールは5分、その他は23時間の送信期限を設けています。期限切れは送らないため、認証メールが届かなかった場合は再発行してください。

## 6. 内蔵の商談予約

`BOOKING_TOKEN_SECRET`と公開URLを設定し、https://form-higuchi.vercel.app/app/settings の「内蔵の商談予約ページ」で受付を有効にします。担当者、受付曜日・時間、参加方法、休業時間を保存すると、顧客ごとの署名付き予約リンクを営業文面へ案内できます。

商談は30分、15分刻み、終了後15分の余白を取り、24時間後から30日先まで受け付けます。同時予約・変更はデータベースのロックで調整します。確定・変更・取消はアプリと通知に反映します。外部カレンダーの空き枠は同期せず、参加URLも自動生成しません。別の予定や休業日は設定画面に登録してください。

## 7. Stripeをテスト環境から設定する

利用する既存アカウントは、表示名`life`、個人事業の`acct_1SOtr4EXrauv37Rg`です。このアカウントの利用は確認済みですが、法的名称・事業者情報や既存ECの商品は変更しません。higuchi-form専用資源だけを識別して処理します。

最初に、この既存アカウントの**テスト環境のキー**を用意します。Vercelの連携追加で新しい環境を作る操作は、既存`life`アカウントのキー取得にはなりません。別アカウントや新しい環境の自動作成・切り替えは行いません。

### 環境変数

| 環境変数 | 内容 |
| --- | --- |
| `STRIPE_SECRET_KEY` | 運営用の制限付きキーを推奨 |
| `STRIPE_ACCOUNT_ID` | キーが属する`acct_...`。実際の接続先をAPIで照合 |
| `HIGUCHI_BILLING_CURRENCY` | 新しい利用は`JPY`。既存USD顧客を自動換算しない |
| `STRIPE_JPY_PRODUCT_ID` | 円建て専用`prod_...` |
| `STRIPE_JPY_METER_ID` | 円建て専用`mtr_...` |
| `STRIPE_JPY_PRICE_ID` | 1通6円の円建て専用`price_...` |
| `STRIPE_JPY_METER_EVENT_NAME` | `higuchi_email_sent_jpy_v1`。円用メーターと同じ値 |
| `STRIPE_PRODUCT_ID`・`STRIPE_METER_ID`・`STRIPE_PRICE_ID`・`STRIPE_METER_EVENT_NAME` | 既存USD利用の専用カタログ。旧料金は1通US$0.04。JPY用IDで上書きしない |
| `STRIPE_WEBHOOK_SECRET` | 共通通知先の署名シークレット |
| `STRIPE_PUBLISHABLE_KEY` | 埋め込み決済に必須。同じアカウント・テスト／本番環境の`pk_...`を、Vercelでは`encrypted`として保存する。`NEXT_PUBLIC_`変数へ複製しない |
| `HIGUCHI_SANDBOX_RETURN_ORIGIN` | StripeネイティブTEST試験の戻り先。隔離したPreviewのHTTPS originを明示する。Production URLは使わない |

APIバージョンは`2026-10-28.endive`です。テスト・本番やJPY・USDのキーとカタログを混在させないでください。組織の顧客・契約対応は`grid_providers`と`grid_provider_credentials`の`higuchi-billing`へ保存します。運営用キーは公開先の機密環境変数に置き、組織設定へ複製しません。ブラウザーには本人確認後の決済に必要な公開キーだけを返します。

テスト用のデータベース・ワークスペースと本番用は分けてください。保存済みの顧客・契約IDを別の環境へ自動で引き継ぐことはできません。本番顧客を接続した後に同じ公開先のキーだけをテスト用へ変更すると、その顧客の処理は停止します。

### 専用カタログの作成

起動時・Checkout時にはカタログを作成しません。次の明示的なコマンドで専用商品・メーター・料金を作成・再利用します。

JPY用の運営者向け作成手順は`higuchi-stripe-provision.ts --key-stdin --currency JPY --catalog-only`です。許可済みのテストアカウントを`--account-id`で指定し、秘密キーは非表示の標準入力から渡します。本番は別のID・キーで照合し、明示的な`--allow-live`が必要です。出力した円用IDは`STRIPE_JPY_*`へ設定します。

以下は従来の非公開キーファイルを使う方法です。実行環境の`HIGUCHI_BILLING_CURRENCY`を確認し、USDの既存カタログをJPY用として登録しないでください。

```sh
bun --conditions=react-server scripts/higuchi-stripe-catalog.ts --key-file "<リポジトリ外の非公開テストキーファイル>" --account-id acct_1SOtr4EXrauv37Rg
```

`--key-file`を省略すると実行環境の`STRIPE_SECRET_KEY`を使います。秘密キーはメモリへ読み取り、表示しません。出力は非秘密情報の`accountId`、`livemode`、`productId`、`meterId`、`priceId`、`eventName`だけです。これらを公開先の対応する変数へ設定します。

既定では本番キーを拒否します。テスト確認後に本番カタログを作る場合だけ`--allow-live`を付けます。スクリプトはWebhook、顧客、契約、請求を作りません。テストと本番のIDは別管理です。

### 制限付きキーの権限

現行REST呼び出しの必要権限です。権限画面の対応する項目を設定してください。カタログ作成用と通常運用用のキーを分ける方法を推奨します。

| 資源 | 通常運用 | カタログ作成時の追加 |
| --- | --- | --- |
| Account | 読み取り | なし |
| Customers | 読み取り・作成・更新 | なし |
| Products・Prices・Billing Meters | 読み取り | 作成 |
| Checkout Sessions | 読み取り・作成 | なし |
| Setup Intents・Payment Intents・Charges | 読み取り | なし |
| Subscriptions | 読み取り・作成・更新 | なし |
| Billing Portal Sessions | 作成 | なし |
| Billing Credit Grants | 読み取り・作成・期限終了 | なし |
| Invoices・Invoice Lines・Invoice Payments | 読み取り | なし |
| Billing Meter Events | 作成 | なし |

### 共通Webhook

組織IDを付けない共通URLを登録します。

```text
https://form-higuchi.vercel.app/api/webhooks/stripe
```

対象イベントは次のとおりです。

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `invoice.paid`
- `invoice.payment_failed`
- `invoice.payment_action_required`
- `invoice.voided`
- `invoice.marked_uncollectible`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `charge.refunded`
- `charge.dispute.created`
- `radar.early_fraud_warning.created`

生の本文の署名、5分以内の時刻、テスト・本番、保存済みの顧客対応を確認します。専用の顧客・契約・商品・料金も照合し、他ECの通知は処理しません。戻り先画面だけで入金を確定しません。通知ID・購入セッションID・請求IDを永続状態で重複排除します。

### 料金・クレジット・失敗時の扱い

新しい円建て利用では、初回・フォローアップメールはGmailの受付確認後に1通6円を記録します。返信は無料でイベントを送りません。固定月額はありません。送信前の予算予約と利用イベントの配信は永続化します。既存USD利用の料金・顧客・契約は保持します。

- カード登録から始める場合は、CheckoutとSetup Intentの成功を確認し、請求用の既定支払方法を設定して、1組織1回の4,500円無料クレジットを付与します。
- 前払いは4,500円・7,500円・15,000円です。実際の支払額を確認して支払済みクレジットを付与し、初回特典の対象なら同額の無料クレジットを追加します。
- **無料4,500円と初回前払い2倍はどちらか一方**です。組織のロック下で競合・重複を防ぎます。
- Stripeへのクレジット反映が完了するまで、アプリの利用可能残高には加えません。
- 月次の従量課金契約に750円の請求閾値を設定します。集計により750円を超える場合があり、月末は750円未満の残額も精算します。即時の請求額上限ではありません。

クレジットは専用メーター料金だけに適用し、請求確定時に消費します。購入済みクレジットを再請求したり、クレジットで精算された請求を二重入金として加算したりしません。今回の承認に従いStripeの自動税計算は使わず、表示金額のまま扱います。

利用イベントIDは送信IDから固定で作ります。**初回試行から23時間を超えた不明なイベントは自動再送せず、運営者の照合へ回します。** 別に、利用日時はStripeが受け付ける過去35日・未来5分以内である必要があります。35日間再送してよいという意味ではありません。StripeへのHTTP要求は1回25秒、同じ操作内では合計55秒を上限にします。

返金では対応する支払済み・特典クレジットの残りをStripeで期限終了にし、送信を停止します。使用済み分、部分返金、請求取消、不正利用・異議申立ては運営者が残高と契約を照合してから再開します。返金や取消の通知だけで自動再開しません。

現在、照合待ちを解除する一般利用者向けの画面・APIはありません。運営者がStripeとアプリの台帳を確認し、残高調整・復旧方法を確定するまで停止を維持します。

## 8. 永続キューと定期処理

`vercel.json`はProductionで`/api/higuchi/cron`を1分ごとに呼びます。`CRON_SECRET`を設定すると、Vercelは`Authorization: Bearer <CRON_SECRET>`で認証します。認証に失敗した要求とProduction以外の要求は実行しません。

送信準備、送信、照合、返信同期、AI分析、課金反映、通知はPostgreSQLへ保存します。短い要求の中で期限付きの処理権を取得し、失敗時は待機して再試行します。Webサーバーや画面の接続を常駐ジョブに使いません。Vercelでは既存基盤の常駐処理も起動しません。`HIGUCHI_ENABLE_LEGACY_WORKERS`は有効にしないでください。

Cronの応答は`processed`・`failed`です。失敗が続く場合は実行ログと永続キューを確認し、秘密キー・本文・トークンのログ出力を追加しないでください。Cron停止中は設定済みでも送信・通知が進みません。

## 9. ログイン前の調査と顧客データ

公開準備中は`HIGUCHI_PUBLIC_PREVIEW=false`にします。トップのURL・事業入力は従来のログイン後の事業設定へ進み、匿名APIと調査workerは停止します。追加スキーマと円用Stripe設定を確認してから`true`へ変更します。この変数と`HIGUCHI_SEND_ENABLED`は別で、調査を公開しても営業送信を停止したまま確認できます。

有効時は`/auto-gtm/company/<domain>/explore`または`/auto-gtm/business/explore`で、会社調査、競合調査、キャンペーン設計、企業候補、意思決定者、個別メールの6工程を表示します。競合は検索で根拠を確認した最大15社、キャンペーンは3〜6つ、プレビューの個別メールは全キャンペーンから配分した最大9通です。Web検索は1調査につき合計3回に制限します。

匿名結果は推測しにくいCookieで所有者を照合し、24時間保存します。期限後は入力・会社情報・候補・文面・エラー本文を消去します。AI費用の台帳、処理ID、本人確認後に取り込んだワークスペースは保持します。匿名調査もOpenAIの全体月額20米ドル上限に含まれます。

`/operator/catalog`ではCSV、Excel、DB出力を取り込み、内容を確認して公開できます。非公開のデータと各組織の私有顧客リストは匿名検索の対象にしません。公開済みデータをキャンペーンの短い業種キーワード、地域、役職、会社規模で絞り込みます。検証状態が不明・catch-allならそのまま表示し、有効判定を創作しません。

データが未公開の場合は候補とメールを架空のサンプルとして表示し、本人確認後の取り込み、カード登録、課金、送信を禁止します。公開済みデータに一致しなかった場合は0件と表示します。新しい外部顧客データサービスの契約やExplee APIの接続は必要ありません。

実候補がある場合だけ、画面内のOTP本人確認、保存済み結果の取り込み、Stripe Payment Elementへ進みます。利用規約と、初回・追客・設定に従った返信対応の開始を確認します。取り込みだけでは送信せず、確認した決済セッションの署名付き通知と保存文面を照合してから開始します。追加認証から戻ったときは既存の決済を再確認し、新たな支払いを作らず再開します。

`HIGUCHI_PREVIEW_FIXTURE=true`は専用テストDBかローカルDBでの画面確認用です。会社・競合も固定の架空データになり、外部AI・探索は呼びません。本番Vercelでは拒否し、サンプル決済もできません。ProductionとPreviewの秘密情報・データベースは分離してください。

返金保証の申請は`/app/billing`、運営者の確認・審査は`/operator/refunds`で行います。対象条件は`src/lib/higuchi/guaranteePolicy.ts`に集約しています。申請や審査だけでStripeから自動返金は行いません。

## 最初の確認順序

1. `HIGUCHI_SEND_ENABLED=false`のままデータベース・Productionの秘密情報をそろえ、運営者APIで組織、`integrations`、`aiBudget`を確認する。
2. 既存Stripeアカウントの**テストキー**で専用カタログを作り、テスト用共通Webhookと署名を設定する。
3. テストカードの登録から無料枠と従量契約の反映を確認する。別の検証用組織では前払いを先に試し、無料枠と2倍特典の排他を確認する。
4. 失敗・追加認証・重複・順序が前後した通知・返金で二重加算や送信再開が起きないことを確認する。閾値・月末の精算はテスト環境だけで確認し、そのために営業メールを大量送信しない。
5. Google OAuthで指定営業アドレスを接続する。Resendのドメイン・配信通知を設定し、合意済みの受信箱で認証通知を確認する。
6. 会社分析を1件実行し、結果と全体AI予算を確認する。Previewでは実行しない。
7. 内蔵予約の受付・休業時間・参加方法を設定し、予約、変更、取消と通知を確認する。
8. 最後に合意済みの検証用宛先・少数のメールに限定して送信を有効にし、受付、返信、配信停止を確認してから対象を広げる。

これは確認手順であり、外部接続・決済・送信を実施済みという意味ではありません。UI変更は手動で確認し、許可なくブラウザ自動操作は行いません。

## 参照

- [Stripe Billing Meters](https://docs.stripe.com/api/billing/meter/create)
- [Stripe Meter Events](https://docs.stripe.com/api/billing/meter-event/create)
- [Stripe Billing Credits](https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits)
- [Stripeの請求閾値](https://docs.stripe.com/billing/subscriptions/usage-based/thresholds)
- [Stripe Invoice Payments](https://docs.stripe.com/api/invoice-payment/list)
- [Gmail APIの権限](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Resend Webhooks](https://resend.com/docs/dashboard/webhooks/introduction)
