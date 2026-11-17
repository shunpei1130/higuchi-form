import { describe, expect, test } from "bun:test";
import { composerValue, shouldProposeProject, workspacePollDelay } from "./liveUpdates";
import type { WorkspaceSnapshot } from "@/lib/higuchi/types";

const snapshot = { mode: "live", projects: [], conversations: [], billing: { paymentStatus: "verified", topupStatus: "idle", pendingCreditCents: 0 } } as unknown as WorkspaceSnapshot;
describe("server updates in the workspace", () => {
  test("polls pending business and billing work promptly without advancing simulation", () => {
    expect(workspacePollDelay(snapshot, false)).toBe(15000);
    expect(workspacePollDelay({ ...snapshot, projects: [{ id: "one", status: "analyzing" }] } as WorkspaceSnapshot, false)).toBe(2000);
    expect(workspacePollDelay({ ...snapshot, billing: { ...snapshot.billing, topupStatus: "pending" } }, false)).toBe(2000);
    expect(workspacePollDelay(snapshot, true)).toBe(60000);
    expect(workspacePollDelay({ ...snapshot, mode: "simulation" }, false)).toBeNull();
  });
  test("waits for actual analysis and never proposes over an existing project campaign", () => {
    expect(shouldProposeProject({ id: "one", status: "analyzing" }, [])).toBe(false);
    expect(shouldProposeProject({ id: "one", status: "needs_setup" }, [])).toBe(false);
    expect(shouldProposeProject({ id: "one", status: "ready" }, [{ projectId: "two" }])).toBe(true);
    expect(shouldProposeProject({ id: "one", status: "ready" }, [{ projectId: "one" }])).toBe(false);
  });
  test("shows a late AI draft but preserves typed replies, including an intentional empty edit", () => {
    expect(composerValue({ value: "", dirty: false }, "後から届いた返信案")).toBe("後から届いた返信案");
    expect(composerValue({ value: "入力中の返信", dirty: true }, "新しいAI案")).toBe("入力中の返信");
    expect(composerValue({ value: "", dirty: true }, "新しいAI案")).toBe("");
    expect(composerValue({ value: "以前の返信", dirty: false }, null)).toBe("");
  });
});
