import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

/**
 * Explicitly opt in with DATABASE_URL and HIGUCHI_BOOKING_TEST_DATABASE_URL pointing to the same disposable,
 * migrated database. This test never sends email: it checks only durable queue rows.
 * Run this file alone with Bun's --conditions=react-server flag.
 */
const testDatabase = process.env.HIGUCHI_BOOKING_TEST_DATABASE_URL;
if (testDatabase && process.env.DATABASE_URL !== testDatabase) throw new Error("予約試験では DATABASE_URL と専用テストDBのURLを一致させてください。");
test.skipIf(!testDatabase)("実DB: 同時予約・再送・変更・取消・通知の原子性と組織分離", async () => {
  const before = { DATABASE_URL: process.env.DATABASE_URL, HIGUCHI_MODE: process.env.HIGUCHI_MODE, BOOKING_TOKEN_SECRET: process.env.BOOKING_TOKEN_SECRET, BETTER_AUTH_URL: process.env.BETTER_AUTH_URL, INTEGRATION_CREDENTIALS_KEY: process.env.INTEGRATION_CREDENTIALS_KEY };
  process.env.DATABASE_URL = testDatabase!;
  process.env.HIGUCHI_MODE = "live";
  process.env.BOOKING_TOKEN_SECRET = `isolated-booking-${randomUUID()}`;
  process.env.BETTER_AUTH_URL = "https://form-higuchi.vercel.app";
  process.env.INTEGRATION_CREDENTIALS_KEY = `isolated-encryption-${randomUUID()}`;
  const [{ db }, { organizations }, { higuchiWorkspaces }, { higuchiBookings, higuchiBookingInvites }, { higuchiJobs }, { createWorkspace }, { runInOrganization, inOrg }, service, { bookingDefaults }, { eq }] = await Promise.all([
    import("@/lib/db"), import("@/lib/auth/schema"), import("../schema"), import("../bookingSchema"), import("../jobs/schema"), import("../state"), import("@/lib/tenancy/scope"), import("./service"), import("./rules"), import("drizzle-orm"),
  ]);
  const orgA = randomUUID(), orgB = randomUUID();
  try {
    await db.insert(organizations).values([{ id: orgA, name: "予約試験A", slug: `booking-test-a-${orgA}` }, { id: orgB, name: "予約試験B", slug: `booking-test-b-${orgB}` }]);
    const fixture = createWorkspace("simulation"); fixture.mode = "live";
    const project = fixture.projects[0], campaign = fixture.campaigns[0];
    const leads = fixture.leads.slice(0, 3);
    await db.insert(higuchiWorkspaces).values({ organizationId: orgA, state: fixture });
    await db.insert(higuchiWorkspaces).values({ organizationId: orgB, state: createWorkspace("live") });
    await runInOrganization(orgA, () => service.saveBookingSettings({ ...bookingDefaults(), enabled: true }));
    const invitations = await Promise.all(leads.map((lead) => service.getInvitationURL({ organizationId: orgA, projectId: project.id, campaignId: campaign.id, leadId: lead.id })));
    const tokens = invitations.map((invite) => new URL(invite.url).pathname.split("/").at(-1)!);
    const page = await service.publicBookingPage(tokens[0]);
    const startsAt = page.days[0].slots[0].startsAt, movedAt = page.days[0].slots[4].startsAt;
    const inputs = leads.map((lead) => ({ startsAt, guestName: lead.name, email: lead.email, requestId: randomUUID() }));
    const attempts = await Promise.allSettled([service.confirmBooking(tokens[0], inputs[0]), service.confirmBooking(tokens[1], inputs[1])]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const winner = attempts.findIndex((attempt) => attempt.status === "fulfilled");
    const succeeded = attempts[winner];
    if (succeeded.status !== "fulfilled") throw new Error("予約が確定しませんでした。");
    const booked = succeeded.value;
    const repeated = await service.confirmBooking(tokens[winner], inputs[winner]);
    expect(repeated.id).toBe(booked.id);
    await runInOrganization(orgA, async () => {
      expect(await db.select().from(higuchiBookings).where(inOrg(higuchiBookings))).toHaveLength(1);
      const jobs = await db.select().from(higuchiJobs).where(inOrg(higuchiJobs));
      expect(jobs).toHaveLength(2);
      expect(jobs.every((job) => typeof job.payload.encryptedPayload === "string")).toBe(true);
      const [saved] = await db.select().from(higuchiWorkspaces).where(inOrg(higuchiWorkspaces));
      expect(saved.state.meetings).toHaveLength(1);
      expect(saved.state.leads.find((lead) => lead.id === leads[winner].id)?.status).toBe("booked");
    });
    const manageToken = new URL(booked.manageUrl).pathname.split("/").at(-1)!;
    const moveRequest = { action: "reschedule" as const, startsAt: movedAt, requestId: randomUUID(), version: booked.version };
    const moved = await service.changeBooking(manageToken, moveRequest);
    expect(moved.startsAt).toBe(movedAt);
    expect((await service.changeBooking(manageToken, moveRequest)).version).toBe(moved.version);
    await expect(service.changeBooking(manageToken, { action: "cancel", requestId: randomUUID(), version: booked.version })).rejects.toThrow();
    const cancelRequest = { action: "cancel" as const, requestId: randomUUID(), version: moved.version };
    const cancelled = await service.changeBooking(manageToken, cancelRequest);
    expect(cancelled.status).toBe("cancelled");
    expect((await service.changeBooking(manageToken, cancelRequest)).version).toBe(cancelled.version);
    expect((await service.publicBookingPage(tokens[1 - winner])).days.flatMap((day) => day.slots).some((slot) => slot.startsAt === movedAt)).toBe(true);
    await runInOrganization(orgA, async () => {
      const [saved] = await db.select().from(higuchiWorkspaces).where(inOrg(higuchiWorkspaces));
      expect(saved.state.meetings[0].status).toBe("cancelled");
      expect(saved.state.leads.find((lead) => lead.id === leads[winner].id)?.status).toBe("interested");
      expect(saved.state.campaigns[0].meetingCount).toBe(0);
      expect(await db.select().from(higuchiJobs).where(inOrg(higuchiJobs))).toHaveLength(6);
    });
    // A failed notification enqueue must roll back both the canonical row and workspace projection.
    const encryptionKey = process.env.INTEGRATION_CREDENTIALS_KEY;
    delete process.env.INTEGRATION_CREDENTIALS_KEY;
    try { await expect(service.confirmBooking(tokens[2], { ...inputs[2], startsAt: movedAt })).rejects.toThrow(); }
    finally { process.env.INTEGRATION_CREDENTIALS_KEY = encryptionKey; }
    await runInOrganization(orgA, async () => {
      expect(await db.select().from(higuchiBookings).where(inOrg(higuchiBookings))).toHaveLength(1);
      expect(await db.select().from(higuchiJobs).where(inOrg(higuchiJobs))).toHaveLength(6);
      const [saved] = await db.select().from(higuchiWorkspaces).where(inOrg(higuchiWorkspaces));
      expect(saved.state.meetings).toHaveLength(1);
    });
    await runInOrganization(orgB, async () => {
      expect(await db.select().from(higuchiBookings).where(inOrg(higuchiBookings))).toHaveLength(0);
      expect(await service.listInternalBookings()).toHaveLength(0);
      expect((await service.getBookingSettings()).enabled).toBe(false);
    });
    await expect(service.publicBookingPage(`${tokens[0].slice(0, -1)}!`)).rejects.toThrow();
  } finally {
    // Only random organizations created by this test are removed from the explicitly supplied test database.
    for (const organizationId of [orgA, orgB]) await runInOrganization(organizationId, async () => { await db.delete(higuchiBookings).where(inOrg(higuchiBookings)); await db.delete(higuchiBookingInvites).where(inOrg(higuchiBookingInvites)); await db.delete(organizations).where(eq(organizations.id, organizationId)); });
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}, 60_000);
