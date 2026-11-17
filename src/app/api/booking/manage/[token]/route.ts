import { z } from "zod";
import { assertBookingLive, assertBookingOrigin, bookingError, bookingJson, limitBookingRequest, readBookingBody } from "@/lib/higuchi/booking/http";
import { changeBooking, managedBooking } from "@/lib/higuchi/booking/service";
import { BookingError } from "@/lib/higuchi/booking/rules";
export const runtime = "nodejs";
type Context = { params: Promise<{ token: string }> };
export async function GET(request: Request, context: Context) { try { assertBookingLive(); limitBookingRequest(request); return bookingJson(await managedBooking((await context.params).token)); } catch (error) { return bookingError(error); } }
export async function POST(request: Request, context: Context) {
  try {
    assertBookingLive(); assertBookingOrigin(request); limitBookingRequest(request, true);
    const parsed = z.object({ action: z.enum(["cancel", "reschedule"]), startsAt: z.string().datetime({ offset: true }).optional(), requestId: z.string().uuid(), version: z.number().int().positive() }).strict().safeParse(await readBookingBody(request));
    if (!parsed.success || parsed.data.action === "reschedule" && !parsed.data.startsAt) throw new BookingError("予約の操作内容を確認してください。");
    return bookingJson(await changeBooking((await context.params).token, parsed.data));
  } catch (error) { return bookingError(error); }
}
