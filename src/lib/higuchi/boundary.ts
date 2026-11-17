/** Exact public entry points; settings and operator APIs never match bearer-token routes. */
export function isPublicBookingPath(pathname:string):boolean {
  return /^\/book\/(?:manage\/)?[A-Za-z0-9_-]{43}$/.test(pathname)||/^\/api\/booking\/(?:manage\/)?[A-Za-z0-9_-]{43}$/.test(pathname);
}
const PUBLIC_PAGES=["/login","/sign-in","/sign-up","/forgot-password","/reset-password","/accept-invitation","/unsubscribe"];
export function isHiguchiPublicPath(pathname:string):boolean {
  if(pathname==="/"||pathname==="/robots.txt"||pathname==="/fonts/Geist-Variable.woff2"||pathname==="/fonts/OFL.txt")return true;
  if(pathname.startsWith("/info/")||isPublicBookingPath(pathname))return true;
  if(PUBLIC_PAGES.some(path=>pathname===path||pathname.startsWith(`${path}/`)))return true;
  if(pathname==="/api/auth"||pathname.startsWith("/api/auth/"))return true;
  return ["/api/webhooks/stripe","/api/higuchi/mail/resend/webhook","/api/higuchi/cron","/api/outreach/unsubscribe"].includes(pathname);
}
