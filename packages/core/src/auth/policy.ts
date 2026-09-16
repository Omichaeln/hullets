/**
 * Central authorisation policy. Roles are capabilities, not hierarchies:
 * platform_admin is TECHNICAL (users, configuration, integrations) and never
 * implies draw, approval, review or prize authority. Every tRPC procedure
 * declares the permission it needs; resource-level checks live in services.
 *
 * promotion_admin and promotion_assistant are the CLIENT's roles — the people
 * running the promotion, as opposed to the platform team running the system.
 * They are read-wide and act-narrow: both see every entry, submission and
 * query, both answer participants, and exactly one difference separates them —
 * an assistant cannot change an entry's standing. Neither gets the draw
 * machinery, winner handling, staff administration, the audit chain,
 * integrations, rules or version editing, or anything that can unmask a
 * national identity number. Those stay with the platform team, and most are
 * dual-controlled and would refuse a single actor anyway.
 */
export const ROLES = ["campaign_manager", "reviewer", "support", "draw_officer", "draw_approver", "fulfilment", "auditor", "platform_admin", "promotion_admin", "promotion_assistant"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  "campaign.read": ["campaign_manager", "reviewer", "support", "draw_officer", "draw_approver", "fulfilment", "auditor", "platform_admin", "promotion_admin", "promotion_assistant"],
  "campaign.write": ["campaign_manager"],
  "campaign.activate": ["campaign_manager"],
  "masterdata.write": ["campaign_manager"],
  "participant.read": ["campaign_manager", "reviewer", "support", "fulfilment", "auditor", "promotion_admin", "promotion_assistant"],
  "participant.correct": ["support"],
  "participant.identity.reveal": ["fulfilment", "auditor"],
  "participant.privacy": ["platform_admin", "support"],
  "submission.read": ["campaign_manager", "reviewer", "support", "auditor", "draw_officer", "promotion_admin", "promotion_assistant"],
  "submission.media": ["reviewer", "auditor"],
  "submission.review": ["reviewer"],
  "submission.reprocess": ["reviewer", "platform_admin"],
  "entry.read": ["campaign_manager", "reviewer", "support", "auditor", "draw_officer", "draw_approver", "fulfilment", "promotion_admin", "promotion_assistant"],
  "entry.disqualify": ["reviewer", "campaign_manager", "promotion_admin"],
  "draw.read": ["draw_officer", "draw_approver", "auditor", "fulfilment", "campaign_manager"],
  "draw.execute": ["draw_officer"],
  "draw.approve": ["draw_approver"],
  "draw.bundle": ["auditor", "draw_approver"],
  "winner.read": ["fulfilment", "auditor", "draw_approver", "support", "campaign_manager"],
  "winner.manage": ["fulfilment"],
  "winner.publish": ["fulfilment", "campaign_manager"],
  "support.handoff": ["support", "promotion_admin", "promotion_assistant"],
  "support.read": ["support", "campaign_manager", "promotion_admin", "promotion_assistant"],
  "ops.read": ["platform_admin", "campaign_manager", "auditor", "support"],
  "ops.retry": ["platform_admin", "support"],
  "ops.alerts.ack": ["platform_admin", "support", "campaign_manager"],
  "settings.write": ["platform_admin"],
  "audit.read": ["auditor", "platform_admin"],
  "report.read": ["campaign_manager", "auditor", "support", "draw_officer", "draw_approver", "fulfilment", "reviewer", "promotion_admin", "promotion_assistant"],
  "report.export": ["auditor"],
  "staff.manage": ["platform_admin"],
  "simulator.use": ["support", "campaign_manager", "reviewer", "platform_admin"],
  "evidence.record": ["campaign_manager", "platform_admin"],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export function can(roles: readonly string[], permission: Permission): boolean {
  const allowed: readonly string[] = PERMISSIONS[permission];
  return roles.some((r) => allowed.includes(r));
}
/** Staff/role/resource matrix for documentation. */
export function permissionMatrix() { return Object.entries(PERMISSIONS).map(([permission, roles]) => ({ permission, roles: [...roles] })); }
