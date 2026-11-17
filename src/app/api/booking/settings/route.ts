import { assertBookingOrigin, bookingError, bookingJson, readBookingBody, assertBookingLive } from "@/lib/higuchi/booking/http";
import { bookingDefaults, BookingError } from "@/lib/higuchi/booking/rules";
import { getBookingSettings, saveBookingSettings } from "@/lib/higuchi/booking/service";
import type { BookingSettings } from "@/lib/higuchi/booking/types";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    if (process.env.HIGUCHI_MODE === "simulation") return bookingJson({ settings: bookingDefaults(), simulation: true, canEdit: false });
    const { withOrgContext, can } = await import("@/lib/auth/context");
    return await withOrgContext(request, async (context) => bookingJson({ settings: await getBookingSettings(), simulation: false, canEdit: can(context, { integrations: ["manage"] }) }));
  } catch (error) { return bookingError(error); }
}
export async function PATCH(request: Request) {
  try {
    assertBookingLive(); assertBookingOrigin(request);
    const { withOrgContext, requirePermission } = await import("@/lib/auth/context");
    return await withOrgContext(request, async (context) => {
      requirePermission(context, { integrations: ["manage"] });
      const body = await readBookingBody(request);
      if (Object.keys(body).some((key) => key !== "settings") || !body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) throw new BookingError("予約設定を確認してください。");
      return bookingJson({ settings: await saveBookingSettings(body.settings as BookingSettings), simulation: false, canEdit: true });
    });
  } catch (error) { return bookingError(error); }
}
