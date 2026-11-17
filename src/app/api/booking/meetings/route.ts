import { bookingError, bookingJson, assertBookingLive } from "@/lib/higuchi/booking/http";
import { listInternalBookings } from "@/lib/higuchi/booking/service";
export const runtime = "nodejs";
export async function GET(request: Request) { try { assertBookingLive(); const { withOrgContext } = await import("@/lib/auth/context"); return await withOrgContext(request, async () => bookingJson({ meetings: await listInternalBookings() })); } catch (error) { return bookingError(error); } }
