/** Exact public entry points; settings and operator APIs never match bearer-token routes. */
export function isPublicBookingPath(pathname:string):boolean {
  return /^\/book\/(?:manage\/)?[A-Za-z0-9_-]{43}$/.test(pathname)||/^\/api\/booking\/(?:manage\/)?[A-Za-z0-9_-]{43}$/.test(pathname);
}
const PUBLIC_PAGES=["/login","/sign-in","/sign-up","/forgot-password","/reset-password","/accept-invitation","/unsubscribe"];
/** Preview URLs identify a display, never an owner. APIs independently verify the anonymous cookie. */
export function isPublicPreviewPage(pathname:string):boolean {
  return pathname==="/auto-gtm/business/explore"||/^\/auto-gtm\/company\/[a-z0-9][a-z0-9.-]{0,252}\/explore$/i.test(pathname);
}
export function isPublicPreviewPath(pathname:string):boolean {
  return isPublicPreviewPage(pathname)||pathname==="/api/previews"||pathname==="/api/previews/dispatch"||/^\/api\/previews\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pathname);
}
export function isHiguchiPublicPath(pathname:string):boolean {
  if(pathname==="/"||pathname==="/robots.txt"||pathname==="/fonts/Geist-Variable.woff2"||pathname==="/fonts/OFL.txt")return true;
  if(pathname.startsWith("/info/")||isPublicBookingPath(pathname)||isPublicPreviewPath(pathname))return true;
  if(PUBLIC_PAGES.some(path=>pathname===path||pathname.startsWith(`${path}/`)))return true;
  if(pathname==="/api/auth"||pathname.startsWith("/api/auth/"))return true;
  return ["/api/webhooks/stripe","/api/higuchi/mail/resend/webhook","/api/higuchi/cron","/api/outreach/unsubscribe"].includes(pathname);
}
