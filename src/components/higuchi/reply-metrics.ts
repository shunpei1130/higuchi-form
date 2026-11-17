import type { Conversation, Lead } from "@/lib/higuchi/types";

/** Count recipients once: follow-ups and replies never expand the denominator. */
export function replyMetrics(leads: readonly Lead[], conversations: readonly Conversation[]) {
  // lastContactAt is set only after an initial/follow-up provider acceptance,
  // and remains available after a lead replies or is suppressed.
  const contacted = new Set(leads.filter((lead) => lead.lastContactAt !== null).map((lead) => lead.id));
  const replied = new Set(conversations
    .filter((conversation) => contacted.has(conversation.leadId) && conversation.messages.some((message) => message.direction === "inbound"))
    .map((conversation) => conversation.leadId));
  return {
    contactedCount: contacted.size,
    repliedCount: replied.size,
    rateLabel: contacted.size ? `${(replied.size / contacted.size * 100).toFixed(1)}%` : "—",
  };
}
