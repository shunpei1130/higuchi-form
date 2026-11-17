/** Explicit operator command: app-specific catalog only; no customers, subscriptions, webhooks or charges. */
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
function fail(message:string):never{console.error(message);process.exit(1);}
async function main(){
  const args=process.argv.slice(2);let keyFile="",accountId="",allowLive=false;
  for(let index=0;index<args.length;index++){
    const argument=args[index];
    if(argument==="--help"){console.log("bun --conditions=react-server scripts/higuchi-stripe-catalog.ts --key-file <private file outside repository> --account-id <acct_id> [--allow-live]");return;}
    if(argument==="--allow-live"){allowLive=true;continue;}
    if(argument==="--key-file"||argument==="--account-id"){
      const value=args[++index];if(!value||value.startsWith("--"))return fail("キーの保存先とStripeアカウントIDを指定してください。");
      if(argument==="--key-file")keyFile=value;else accountId=value;continue;
    }
    return fail("未対応の指定です。--helpで使用方法を確認してください。");
  }
  if(keyFile){
    const path=await realpath(resolve(keyFile)),workspace=await realpath(root),inside=relative(workspace,path);
    if(!(isAbsolute(inside)||inside===".."||inside.startsWith(`..${sep}`)))return fail("秘密キーはソースの保存先の外にある非公開ファイルで指定してください。");
    if((await stat(path)).size>16384)return fail("秘密キーのファイル形式を確認してください。");
    process.env.STRIPE_SECRET_KEY=(await readFile(path,"utf8")).trim();
  }
  if(accountId){if(!/^acct_[a-zA-Z0-9]+$/.test(accountId))return fail("StripeアカウントIDの形式を確認してください。");process.env.STRIPE_ACCOUNT_ID=accountId;}
  if(!/^(?:rk|sk)_(?:test|live)_/.test(process.env.STRIPE_SECRET_KEY??""))return fail("Stripeの制限付きキーを非公開ファイルか実行環境のシークレットから設定してください。");
  if(!/^acct_[a-zA-Z0-9]+$/.test(process.env.STRIPE_ACCOUNT_ID??""))return fail("接続先のStripeアカウントIDを指定してください。");
  const livemode=/^(?:rk|sk)_live_/.test(process.env.STRIPE_SECRET_KEY!);
  if(livemode&&!allowLive)return fail("最初にStripeのテスト環境で確認してください。本番用の料金作成には--allow-liveが必要です。");
  const {provisionStripeBillingCatalog}=await import("../src/lib/higuchi/providerBilling");
  const catalog=await provisionStripeBillingCatalog({allowLive});
  console.log(JSON.stringify({accountId:process.env.STRIPE_ACCOUNT_ID,livemode,...catalog}));
}
try{await main();}catch{fail("Stripeの料金設定を完了できませんでした。接続・権限・同じ環境のアカウントIDを確認してください。秘密情報を含む出力は表示していません。");}
