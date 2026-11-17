import { z } from "zod";
import { assertBookingLive, assertBookingOrigin, bookingError, bookingJson, limitBookingRequest, readBookingBody } from "@/lib/higuchi/booking/http";
import { confirmBooking, publicBookingPage } from "@/lib/higuchi/booking/service";
import { BookingError } from "@/lib/higuchi/booking/rules";
export const runtime = "nodejs";
type Context = { params: Promise<{ token: string }> };
export async function GET(request: Request, context: Context) { try { assertBookingLive(); limitBookingRequest(request); return bookingJson(await publicBookingPage((await context.params).token)); } catch (error) { return bookingError(error); } }
export async function POST(request: Request, context: Context) {
  try {
    assertBookingLive(); assertBookingOrigin(request); limitBookingRequest(request, true);
    const parsed = z.object({ startsAt: z.string().datetime({ offset: true }), guestName: z.string().trim().min(1).max(120), email: z.string().trim().email().max(254), requestId: z.string().uuid() }).strict().safeParse(await readBookingBody(request));
    if (!parsed.success) throw new BookingError("お名前・メールアドレス・予約日時を確認してください。");
    return bookingJson(await confirmBooking((await context.params).token, parsed.data));
  } catch (error) { return bookingError(error); }
}
