import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId, inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { higuchiWorkspaces } from "../schema";
import { normalizeWorkspaceState, recordActivity } from "../state";
import { higuchiBookingSettings, higuchiBookingInvites, higuchiBookings } from "../bookingSchema";
import { enqueueNotification } from "../notifications";
import { assertAvailableSlot, assertCanChange, availableDays, bookingDefaults, BookingError } from "./rules";
import { bookingOrigin, bookingSecret, bookingToken, bookingTokenHash } from "./tokens";
import type { BookingReceipt, BookingSettings, PublicBookingPage } from "./types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Invite = typeof higuchiBookingInvites.$inferSelect;
type BookingRow = typeof higuchiBookings.$inferSelect;
const tokenError = () => new BookingError("予約リンクが無効か、有効期限が切れています。", 404, "INVALID_TOKEN");
const receipt = (booking: BookingRow, settings: BookingSettings, now = new Date()): BookingReceipt => ({
  id: booking.id, title: settings.title, hostName: settings.hostName, guestName: booking.guestName, guestEmail: booking.guestEmail,
  startsAt: booking.startsAt.toISOString(), endsAt: booking.endsAt.toISOString(), status: booking.status,
  timezone: settings.timezone, locationText: settings.locationText, locationUrl: settings.locationUrl,
  manageUrl: `${bookingOrigin()}/book/manage/${bookingToken("manage", booking.id, bookingSecret())}`,
  canChange: booking.status === "booked" && booking.startsAt.getTime() > now.getTime(), version: booking.version,
});

export async function getBookingSettings(): Promise<BookingSettings> {
  const [row] = await db.select().from(higuchiBookingSettings).where(inOrg(higuchiBookingSettings)).limit(1);
  return row?.settings ?? bookingDefaults();
}
export async function saveBookingSettings(input: BookingSettings): Promise<BookingSettings> {
  const { validateBookingSettings } = await import("./rules");
  const settings = validateBookingSettings(input);
  if (settings.enabled) { bookingSecret(); bookingOrigin(); }
  try {
    await db.insert(higuchiBookingSettings).values({ organizationId: currentOrganizationId(), hostEmail: settings.hostEmail, settings }).onConflictDoUpdate({ target: higuchiBookingSettings.organizationId, set: { settings, hostEmail: settings.hostEmail, updatedAt: new Date() } });
  } catch (error) {
    if ((error as { code?: string }).code === "23505" || (error as { cause?: { code?: string } }).cause?.code === "23505") throw new BookingError("この担当者は別の組織ですでに予約を受け付けています。", 409);
    throw error;
  }
  return settings;
}

/** Call outside a workspace transaction; this routine locks the shared host before issuing the link. */
export async function getInvitationURL(input: { organizationId: string; projectId: string; campaignId: string; leadId: string }): Promise<{ url: string; expiresAt: string }> {
  return runInOrganization(input.organizationId, () => db.transaction(async (tx) => {
    const [host] = await tx.select().from(higuchiBookingSettings).where(inOrg(higuchiBookingSettings)).for("update");
    if (!host?.settings.enabled) throw new BookingError("内蔵予約ページを設定・公開してから送信してください。", 409, "BOOKING_UNCONFIGURED");
    const [workspace] = await tx.select().from(higuchiWorkspaces).where(inOrg(higuchiWorkspaces)).limit(1);
    const lead = workspace?.state.leads.find((item) => item.id === input.leadId && item.projectId === input.projectId && item.campaignId === input.campaignId);
    if (!lead || lead.status === "suppressed") throw tokenError();
    const secret = bookingSecret(), now = new Date();
    const [existing] = await tx.select().from(higuchiBookingInvites).where(and(inOrg(higuchiBookingInvites), eq(higuchiBookingInvites.projectId, input.projectId), eq(higuchiBookingInvites.campaignId, input.campaignId), eq(higuchiBookingInvites.leadId, input.leadId), isNull(higuchiBookingInvites.revokedAt))).orderBy(desc(higuchiBookingInvites.createdAt)).limit(1);
    if (existing && existing.expiresAt > now) {
      const token = bookingToken("invite", existing.id, secret);
      if (bookingTokenHash(token) === existing.tokenHash) return { url: `${bookingOrigin()}/book/${token}`, expiresAt: existing.expiresAt.toISOString() };
    }
    const id = randomUUID(), token = bookingToken("invite", id, secret), expiresAt = new Date(now.getTime() + 30 * 86_400_000);
    await tx.insert(higuchiBookingInvites).values({ ...input, id, tokenHash: bookingTokenHash(token), expiresAt });
    return { url: `${bookingOrigin()}/book/${token}`, expiresAt: expiresAt.toISOString() };
  }));
}

/** Token lookup is the public bootstrap identity, before an organization scope exists; no personal data is selected here. */
async function inviteIdentity(token: string) {
  const [identity] = await db.select({ id: higuchiBookingInvites.id, organizationId: higuchiBookingInvites.organizationId }).from(higuchiBookingInvites).where(eq(higuchiBookingInvites.tokenHash, bookingTokenHash(token))).limit(1);
  if (!identity) throw tokenError();
  return identity;
}
async function managementIdentity(token: string) {
  const [identity] = await db.select({ id: higuchiBookings.id, organizationId: higuchiBookings.organizationId }).from(higuchiBookings).where(eq(higuchiBookings.manageTokenHash, bookingTokenHash(token))).limit(1);
  if (!identity) throw tokenError();
  return identity;
}
function validInvite(invite: Invite | undefined, now: Date): asserts invite is Invite { if (!invite || invite.revokedAt || invite.expiresAt <= now) throw tokenError(); }
function busyRows(bookings: readonly BookingRow[]) { return bookings.map((booking) => ({ id: booking.id, startsAt: booking.startsAt.toISOString(), endsAt: booking.endsAt.toISOString(), status: booking.status })); }
async function hostAndBookings(tx: Tx, lock = false) {
  const query = tx.select().from(higuchiBookingSettings).where(inOrg(higuchiBookingSettings));
  const [host] = await (lock ? query.for("update") : query);
  if (!host?.settings.enabled) throw new BookingError("現在、予約の受付を停止しています。担当者にご連絡ください。", 409, "BOOKING_CLOSED");
  const booked = await tx.select().from(higuchiBookings).where(and(inOrg(higuchiBookings), eq(higuchiBookings.status, "booked")));
  return { settings: host.settings, booked };
}

export async function publicBookingPage(token: string): Promise<PublicBookingPage> {
  const identity = await inviteIdentity(token);
  return runInOrganization(identity.organizationId, () => db.transaction(async (tx) => {
    const now = new Date();
    const [invite] = await tx.select().from(higuchiBookingInvites).where(and(inOrg(higuchiBookingInvites), eq(higuchiBookingInvites.id, identity.id)));
    validInvite(invite, now);
    const { settings, booked } = await hostAndBookings(tx);
    const active = booked.some((booking) => booking.leadId === invite.leadId && booking.campaignId === invite.campaignId);
    return { title: settings.title, hostName: settings.hostName, timezone: settings.timezone, durationMinutes: settings.durationMinutes, locationText: settings.locationText, days: active ? [] : availableDays(settings, busyRows(booked), now), booked: active };
  }));
}

async function projectBooking(tx: Tx, booking: BookingRow, settings: BookingSettings, kind: "booking.confirmed" | "booking.rescheduled" | "booking.cancelled") {
  const [workspace] = await tx.select().from(higuchiWorkspaces).where(inOrg(higuchiWorkspaces)).for("update");
  if (!workspace) throw tokenError();
  const state = normalizeWorkspaceState(structuredClone(workspace.state));
  const lead = state.leads.find((item) => item.id === booking.leadId && item.projectId === booking.projectId && item.campaignId === booking.campaignId);
  const campaign = state.campaigns.find((item) => item.id === booking.campaignId && item.projectId === booking.projectId);
  if (!lead || !campaign) throw tokenError();
  if (kind === "booking.confirmed" && lead.status === "suppressed") throw new BookingError("現在このご案内からは予約を受け付けていません。担当者にご連絡ください。", 409);
  let meeting = state.meetings.find((item) => item.id === booking.id);
  if (!meeting) { meeting = { id: booking.id, projectId: booking.projectId, campaignId: booking.campaignId, leadId: booking.leadId, startsAt: booking.startsAt.toISOString(), endsAt: booking.endsAt.toISOString(), status: booking.status, provider: "internal" }; state.meetings.push(meeting); }
  else { meeting.startsAt = booking.startsAt.toISOString(); meeting.endsAt = booking.endsAt.toISOString(); meeting.status = booking.status; }
  if (booking.status === "booked") {
    if (lead.status !== "suppressed") lead.status = "booked";
    lead.nextFollowUpAt = null;
    for (const outgoing of state.internal.outbox) if (outgoing.leadId === lead.id && ["reserved", "preparing"].includes(outgoing.status)) outgoing.status = "cancelled";
    for (const conversation of state.conversations.filter((item) => item.leadId === lead.id)) { if (conversation.status !== "suppressed") conversation.status = "booked"; conversation.pendingReply = null; conversation.autoReplyAt = null; }
  } else if (lead.status === "booked" && !state.meetings.some((item) => item.leadId === lead.id && item.status === "booked")) {
    lead.status = "interested";
    for (const conversation of state.conversations.filter((item) => item.leadId === lead.id && item.status === "booked")) conversation.status = "interested";
  }
  campaign.meetingCount = state.meetings.filter((item) => item.campaignId === campaign.id && item.status === "booked").length;
  state.now = new Date().toISOString();
  recordActivity(state, kind === "booking.cancelled" ? "商談予約が取り消されました。追客は自動再開しません。" : kind === "booking.rescheduled" ? "商談の日程が変更されました。" : "内蔵予約ページから商談が予約されました。", "success", booking.projectId);
  await tx.update(higuchiWorkspaces).set({ state, updatedAt: new Date() }).where(inOrg(higuchiWorkspaces));
  const details = receipt(booking, settings);
  const data = { ...details, eventTitle: settings.title, bookingId: booking.id, version: booking.version, guestName: booking.guestName, guestEmail: booking.guestEmail };
  // The canonical reservation, product projection and both durable email jobs commit together.
  for (const to of new Set([booking.guestEmail.toLowerCase(), settings.hostEmail.toLowerCase()])) await enqueueNotification(tx, { organizationId: booking.organizationId, to, kind, data, idempotencyKey: `booking:${booking.id}:${booking.version}:${kind}:${to}` });
}

export async function confirmBooking(token: string, input: { startsAt: string; guestName: string; email: string; requestId: string }): Promise<BookingReceipt> {
  const identity = await inviteIdentity(token);
  return runInOrganization(identity.organizationId, () => db.transaction(async (tx) => {
    const now = new Date(), { settings, booked } = await hostAndBookings(tx, true);
    const [invite] = await tx.select().from(higuchiBookingInvites).where(and(inOrg(higuchiBookingInvites), eq(higuchiBookingInvites.id, identity.id)));
    validInvite(invite, now);
    const [existing] = await tx.select().from(higuchiBookings).where(and(inOrg(higuchiBookings), eq(higuchiBookings.requestId, input.requestId)));
    if (existing) { if (existing.inviteId !== invite.id) throw new BookingError("操作IDが別の予約で使用されています。", 409); return receipt(existing, settings, now); }
    const [workspace] = await tx.select().from(higuchiWorkspaces).where(inOrg(higuchiWorkspaces)).limit(1);
    const lead = workspace?.state.leads.find((item) => item.id === invite.leadId && item.campaignId === invite.campaignId && item.projectId === invite.projectId);
    if (!lead || lead.status === "suppressed" || lead.email.toLowerCase() !== input.email.trim().toLowerCase()) throw new BookingError("ご案内を受け取ったメールアドレスを入力してください。", 400, "EMAIL_MISMATCH");
    if (booked.some((booking) => booking.leadId === invite.leadId && booking.campaignId === invite.campaignId)) throw new BookingError("このご案内では、すでに予約が確定しています。確認メールの変更リンクをご利用ください。", 409, "ALREADY_BOOKED");
    const slot = assertAvailableSlot(settings, busyRows(booked), input.startsAt, now), id = randomUUID();
    const [booking] = await tx.insert(higuchiBookings).values({ id, organizationId: identity.organizationId, projectId: invite.projectId, campaignId: invite.campaignId, leadId: invite.leadId, inviteId: invite.id,
      startsAt: new Date(slot.startsAt), endsAt: new Date(slot.endsAt), guestName: input.guestName.trim(), guestEmail: input.email.trim().toLowerCase(), status: "booked", requestId: input.requestId,
      manageTokenHash: bookingTokenHash(bookingToken("manage", id, bookingSecret())), manageExpiresAt: new Date(Date.parse(slot.endsAt) + 86_400_000), processedRequests: [], version: 1,
    }).returning();
    await projectBooking(tx, booking, settings, "booking.confirmed");
    return receipt(booking, settings, now);
  }));
}

export async function managedBooking(token: string): Promise<{ booking: BookingReceipt; days: PublicBookingPage["days"] }> {
  const identity = await managementIdentity(token);
  return runInOrganization(identity.organizationId, () => db.transaction(async (tx) => {
    const [booking] = await tx.select().from(higuchiBookings).where(and(inOrg(higuchiBookings), eq(higuchiBookings.id, identity.id)));
    if (!booking || booking.manageExpiresAt <= new Date()) throw tokenError();
    const [host] = await tx.select().from(higuchiBookingSettings).where(inOrg(higuchiBookingSettings));
    if (!host) throw tokenError();
    const booked = await tx.select().from(higuchiBookings).where(and(inOrg(higuchiBookings), eq(higuchiBookings.status, "booked")));
    return { booking: receipt(booking, host.settings), days: availableDays(host.settings, busyRows(booked.filter((item) => item.id !== booking.id))) };
  }));
}

export async function changeBooking(token: string, input: { action: "cancel" | "reschedule"; startsAt?: string; requestId: string; version: number }): Promise<BookingReceipt> {
  const identity = await managementIdentity(token);
  return runInOrganization(identity.organizationId, () => db.transaction(async (tx) => {
    // Always take the host lock first, including cancellations and moves.
    const [host] = await tx.select().from(higuchiBookingSettings).where(inOrg(higuchiBookingSettings)).for("update");
    if (!host) throw tokenError();
    const [booking] = await tx.select().from(higuchiBookings).where(and(inOrg(higuchiBookings), eq(higuchiBookings.id, identity.id))).for("update");
    const now = new Date(); if (!booking || booking.manageExpiresAt <= now) throw tokenError();
    if (booking.processedRequests.includes(input.requestId)) return receipt(booking, host.settings, now);
    if (booking.version !== input.version) throw new BookingError("予約内容が更新されています。ページを再読み込みしてください。", 409, "VERSION_CONFLICT");
    assertCanChange(booking.startsAt.toISOString(), booking.status, now);
    const booked = await tx.select().from(higuchiBookings).where(and(inOrg(higuchiBookings), eq(higuchiBookings.status, "booked")));
    const slot = input.action === "reschedule" ? assertAvailableSlot(host.settings, busyRows(booked.filter((item) => item.id !== booking.id)), input.startsAt ?? "", now) : null;
    const [updated] = await tx.update(higuchiBookings).set({ status: input.action === "cancel" ? "cancelled" : "booked", ...(slot ? { startsAt: new Date(slot.startsAt), endsAt: new Date(slot.endsAt), manageExpiresAt: new Date(Date.parse(slot.endsAt) + 86_400_000) } : {}), version: booking.version + 1, processedRequests: [...booking.processedRequests, input.requestId].slice(-100), updatedAt: now }).where(and(inOrg(higuchiBookings), eq(higuchiBookings.id, booking.id))).returning();
    await projectBooking(tx, updated, host.settings, input.action === "cancel" ? "booking.cancelled" : "booking.rescheduled");
    return receipt(updated, host.settings, now);
  }));
}

export async function bookingIsConfigured(): Promise<boolean> {
  if (!(await getBookingSettings()).enabled) return false;
  try { bookingSecret(); bookingOrigin(); return true; } catch (error) { if (error instanceof BookingError) return false; throw error; }
}
export async function getBookingStatus(organizationId: string) {
  if (process.env.HIGUCHI_MODE === "simulation") return { connected: true, status: "simulation" as const, detail: "外部カレンダーと同期しない模擬予約です。" };
  return runInOrganization(organizationId, async () => {
    const ready = await bookingIsConfigured();
    return { connected: ready, status: ready ? "ready" as const : "unconfigured" as const, detail: ready ? "内蔵予約ページで予約・変更・取消を受け付けます。外部カレンダーとは同期しません。" : "内蔵予約ページの公開設定が必要です。" };
  });
}
export async function listInternalBookings(): Promise<BookingReceipt[]> {
  const settings = await getBookingSettings();
  const bookings = await db.select().from(higuchiBookings).where(inOrg(higuchiBookings)).orderBy(desc(higuchiBookings.startsAt)).limit(200);
  return bookings.map((booking) => receipt(booking, settings));
}
