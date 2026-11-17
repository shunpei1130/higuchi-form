import type { Campaign, Project, WorkspaceSnapshot } from "@/lib/higuchi/types";

/** Simulation advances only through its explicit controls. */
export function workspacePollDelay(snapshot: WorkspaceSnapshot, hidden: boolean): number | null {
  if (snapshot.mode !== "live") return null;
  if (hidden) return 60000;
  const waiting = snapshot.projects.some(project => project.status === "analyzing") || snapshot.billing.paymentStatus === "pending" || snapshot.billing.topupStatus === "pending" || snapshot.billing.pendingCreditCents > 0 || snapshot.conversations.some(conversation => Boolean(conversation.autoReplyAt));
  return waiting ? 2000 : 15000;
}

export function shouldProposeProject(project: Pick<Project, "id" | "status"> | null | undefined, campaigns: Pick<Campaign, "projectId">[]): boolean {
  return Boolean(project?.status === "ready" && !campaigns.some(campaign => campaign.projectId === project.id));
}

/** A late server draft may fill an untouched composer, never a user's typed reply. */
export function composerValue(edit: { value: string; dirty: boolean }, saved: string | null | undefined): string {
  return edit.dirty ? edit.value : saved ?? "";
}
