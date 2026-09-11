/** Winner lifecycle: allowed status moves (pure; shared with the console). */
export const TRANSITIONS: Record<string, string[]> = {
  selected: ["notified", "unreachable", "ineligible", "expired", "replaced", "declined"], notified: ["verified", "unreachable", "declined", "ineligible", "expired", "disputed", "replaced"],
  verified: ["accepted", "declined", "ineligible", "expired", "disputed", "replaced"], accepted: ["collected", "expired", "ineligible", "disputed", "replaced"], disputed: ["verified", "ineligible", "replaced"],
  unreachable: ["notified", "expired", "replaced"], collected: [], declined: ["replaced"], ineligible: ["replaced"], expired: ["replaced"], replaced: [],
};
