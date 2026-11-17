import { getSessionCookie } from "better-auth/cookies";
import { NextRequest, NextResponse } from "next/server";
import { migrationMutationBlockReason } from "@/lib/migration/controls";
import { DEMO_READ_ONLY_CODE, DEMO_READ_ONLY_MESSAGE, demoRequestBlock, isDemoMode } from "@/lib/demo/mode";
import { isHiguchiSimulation, isLoopbackHost } from "@/lib/higuchi/mode";
import { isHiguchiPublicPath, isPublicPreviewPath } from "@/lib/higuchi/boundary";
import { bootstrapEnabledForWeb } from "@/lib/auth/operatorBootstrapPolicy";

export function proxy(request:NextRequest){
  const {pathname}=request.nextUrl;
  // Only a CLI transaction may grant the initial platform-operator role.
  if(!bootstrapEnabledForWeb({nodeEnv:process.env.NODE_ENV,vercel:process.env.VERCEL})&&(pathname==="/setup"||pathname==="/api/setup"||pathname.startsWith("/setup/")||pathname.startsWith("/api/setup/")))return NextResponse.json({error:"この環境の初期設定は運営者が行います。"},{status:404});
  const productPath=pathname==="/app"||pathname==="/operator"||pathname.startsWith("/operator/")||pathname.startsWith("/app/")||pathname.startsWith("/api/higuchi/")||pathname==="/api/projects"||pathname.startsWith("/api/projects/")||isPublicPreviewPath(pathname);
  if(isHiguchiSimulation()&&pathname.startsWith("/api/")&&!productPath&&!pathname.startsWith("/api/auth/"))return NextResponse.json({error:"この操作は本番接続モードで利用できます。",code:"SIMULATION_ENDPOINT_DISABLED"},{status:409});
  if(isHiguchiSimulation()&&productPath){
    if(!isLoopbackHost(request.nextUrl.hostname))return NextResponse.json({error:"検証環境はこのコンピューター上でのみ利用できます。"},{status:403});
    // These named APIs verify the signed simulation session themselves.
    return NextResponse.next();
  }
  const migrationBlock=migrationMutationBlockReason(pathname,request.method);
  if(migrationBlock)return NextResponse.json({error:migrationBlock},{status:503});
  const demo=demoRequestBlock(pathname,request.method);
  if(demo?.kind==="enter"){
    const url=request.nextUrl.clone(),from=request.nextUrl.searchParams.get("from");url.pathname="/demo";url.search="";if(from)url.searchParams.set("from",from);return NextResponse.redirect(url);
  }
  if(demo?.kind==="refuse")return NextResponse.json({error:DEMO_READ_ONLY_MESSAGE,code:DEMO_READ_ONLY_CODE},{status:403});
  if(demo?.kind==="silent")return NextResponse.json({ok:true});
  if(pathname==="/demo"&&isDemoMode())return NextResponse.next();
  // These webhooks and Cron verify their own signatures/Bearer secret.
  // Public booking paths contain one opaque token; settings never match.
  const isPublic=isHiguchiPublicPath(pathname)||
    (process.env.NODE_ENV!=="production"&&process.env.VERCEL!=="1"&&(pathname==="/setup"||pathname==="/api/setup"))||
    pathname.startsWith("/_next/")||pathname.startsWith("/favicon")||
    (!pathname.startsWith("/api/")&&/\.(?:png|jpe?g|gif|svg|webp|ico)$/i.test(pathname));
  if(isPublic)return NextResponse.next();
  // Cookie presence only avoids an early redirect. Data routes verify the
  // real session, active organization, membership and permission themselves.
  if(getSessionCookie(request))return NextResponse.next();
  if(pathname.startsWith("/api/"))return NextResponse.json({error:"続けるにはログインしてください。",code:"UNAUTHENTICATED"},{status:401});
  const url=request.nextUrl.clone();url.pathname=isDemoMode()?"/demo":"/sign-in";url.search="";url.searchParams.set("from",`${pathname}${request.nextUrl.search}`);return NextResponse.redirect(url);
}
// Every API passes through this boundary, including names with static suffixes.
export const config={matcher:["/api/:path*","/((?!api/|_next/static|_next/image|favicon|fonts/|.*\\.(?:png|jpe?g|gif|svg|webp|ico)$).*)"]};
