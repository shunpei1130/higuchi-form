/** Explicit, loopback-only local simulator. Does not install services or touch a live database. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const envFile = path.join(root, ".env.local");
if (!existsSync(envFile)) {
  writeFileSync(envFile, [
    "HIGUCHI_MODE=simulation", "AUTH_SIGNUP=open", "INTERNAL_SCHEDULER=false",
    "BETTER_AUTH_URL=http://localhost:3000", "NEXT_PUBLIC_APP_URL=http://localhost:3000",
    `BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}`,
    `HIGUCHI_SESSION_SECRET=${randomBytes(32).toString("hex")}`,
    `INTEGRATION_CREDENTIALS_KEY=${randomBytes(32).toString("base64")}`,
    "DATABASE_URL=postgres://higuchi:local-only@127.0.0.1:5432/higuchi", "DATABASE_SSL=disable", "NEXT_TELEMETRY_DISABLED=1", "",
  ].join("\n"), {flag:"wx",mode:0o600});
}
console.log("higuchi-form の検証モードを起動します。実際のメール送信・請求は行いません。");
const child = spawn(process.execPath, [path.join(root,"node_modules","next","dist","bin","next"),"dev","--webpack","--hostname","127.0.0.1","--port",process.env.PORT || "3000"], {
  cwd:root, stdio:"inherit", windowsHide:true,
  env:{...process.env,HIGUCHI_MODE:"simulation",NEXT_TELEMETRY_DISABLED:"1"},
});
child.on("error",(error)=>{console.error("起動できませんでした。依存ライブラリをインストールしてから再実行してください。",error.message);process.exitCode=1;});
child.on("exit",(code)=>{process.exitCode=code??1;});
process.on("SIGINT",()=>{child.kill("SIGINT");});
process.on("SIGTERM",()=>{child.kill("SIGTERM");});
