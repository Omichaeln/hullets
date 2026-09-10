/**
 * Central authorisation policy. Roles are capabilities, not hierarchies:
 * platform_admin is TECHNICAL (users, configuration, integrations) and never
 * implies draw, approval, review or prize authority. Every tRPC procedure
 * declares the permission it needs; resource-level checks live in services.
 */
export const ROLES = ["campaign_manager", "reviewer", "support", "draw_officer", "draw_approver", "fulfilment", "auditor", "platform_admin"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  "campaign.read": ["campaign_manager", "reviewer", "support", "draw_officer", "draw_approver", "fulfilment", "auditor", "platform_admin"],
  "campaign.write": ["campaign_manager"],
  "campaign.activate": ["campaign_manager"],
  "masterdata.write": ["campaign_manager"],
  "participant.read": ["campaign_manager", "reviewer", "support", "fulfilment", "auditor"],
  "participant.correct": ["support"],
  "participant.identity.reveal": ["fulfilment", "auditor"],
  "participant.privacy": ["platform_admin", "support"],
  "submission.read": ["campaign_manager", "reviewer", "support", "auditor", "draw_officer"],
  "submission.media": ["reviewer", "auditor"],
  "submission.review": ["reviewer"],
  "submission.reprocess": ["reviewer", "platform_admin"],
  "entry.read": ["campaign_manager", "reviewer", "support", "auditor", "draw_officer", "draw_approver", "fulfilment"],
  "entry.disqualify": ["reviewer", "campaign_manager"],
  "draw.read": ["draw_officer", "draw_approver", "auditor", "fulfilment", "campaign_manager"],
  "draw.execute": ["draw_officer"],
  "draw.approve": ["draw_approver"],
  "draw.bundle": ["auditor", "draw_approver"],
  "winner.read": ["fulfilment", "auditor", "draw_approver", "support", "campaign_manager"],
  "winner.manage": ["fulfilment"],
  "winner.publish": ["fulfilment", "campaign_manager"],
  "support.handoff": ["support"],
  "support.read": ["support", "campaign_manager"],
  "ops.read": ["platform_admin", "campaign_manager", "auditor", "support"],
  "ops.retry": ["platform_admin", "support"],
  "ops.alerts.ack": ["platform_admin", "support", "campaign_manager"],
  "settings.write": ["platform_admin"],
  "audit.read": ["auditor", "platform_admin"],
  "report.read": ["campaign_manager", "auditor", "support", "draw_officer", "draw_approver", "fulfilment", "reviewer"],
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
