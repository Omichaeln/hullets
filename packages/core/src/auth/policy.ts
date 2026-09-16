/**
 * Central authorisation policy. Roles are capabilities, not hierarchies.
 *
 * The platform team is READ-WIDE and ACT-NARROW. Every platform role can see
 * the whole promotion — campaigns and their configuration, participants,
 * submissions, entries, draws, winners and the reports — because a person who
 * cannot see the campaign cannot understand the system they are asked to run,
 * review, draw or administer. What each role can DO stays narrow and is the
 * thing this file actually protects: editing and activating a campaign is the
 * campaign manager's; deciding a receipt is the reviewer's; freezing and
 * executing a draw is the draw officer's and approving it the approver's, and
 * the service refuses to let one person do both; prize handling is fulfilment's;
 * unmasking a national identity number is fulfilment's and the auditor's, and
 * audited; exports are the auditor's. platform_admin is TECHNICAL (accounts,
 * settings, integrations): it reads everything and never gains draw, approval,
 * review, prize or export authority.
 *
 * promotion_admin and promotion_assistant are the CLIENT's roles — the people
 * running the promotion, as opposed to the platform team running the system.
 * They are read-wide over the desk and act-narrow: both see every entry,
 * submission and query, both answer participants, and exactly one difference
 * separates them — an assistant cannot change an entry's standing. Neither gets
 * the draw machinery, winner handling, staff administration, the audit chain,
 * integrations, rules or version editing, or anything that can unmask a
 * national identity number. Those stay with the platform team, and most are
 * dual-controlled and would refuse a single actor anyway.
 */
export const ROLES = ["campaign_manager", "reviewer", "support", "draw_officer", "draw_approver", "fulfilment", "auditor", "platform_admin", "promotion_admin", "promotion_assistant"] as const;
export type Role = (typeof ROLES)[number];
/** The platform team: anyone holding one of these reaches the technical console. */
export const PLATFORM_ROLES: readonly Role[] = ["campaign_manager", "reviewer", "support", "draw_officer", "draw_approver", "fulfilment", "auditor", "platform_admin"];
/** The client's promotion team, who get the promotion desk. */
export const PROMOTION_ROLES: readonly Role[] = ["promotion_admin", "promotion_assistant"];

export const PERMISSIONS = {
  "campaign.read": ["campaign_manager", "reviewer", "support", "draw_officer", "draw_approver", "fulfilment", "auditor", "platform_admin", "promotion_admin", "promotion_assistant"],
  "campaign.write": ["campaign_manager"],
  "campaign.activate": ["campaign_manager"],
  "masterdata.write": ["campaign_manager"],
  "participant.read": ["campaign_manager", "reviewer", "support", "draw_officer", "draw_approver", "fulfilment", "auditor", "platform_admin", "promotion_admin", "promotion_assistant"],
  "participant.correct": ["support"],
  "participant.identity.reveal": ["fulfilment", "auditor"],
  "participant.privacy": ["platform_admin", "support"],
  "submission.read": ["campaign_manager", "reviewer", "support", "draw_officer", "draw_approver", "fulfilment", "auditor", "platform_admin", "promotion_admin", "promotion_assistant"],
  "submission.media": ["reviewer", "auditor"],
  "submission.review": ["reviewer"],
  "submission.reprocess": ["reviewer", "platform_admin"],
  "entry.read": ["campaign_manager", "reviewer", "support", "draw_officer", "draw_approver", "fulfilment", "auditor", "platform_admin", "promotion_admin", "promotion_assistant"],
  "entry.disqualify": ["reviewer", "campaign_manager", "promotion_admin"],
  "draw.read": ["campaign_manager", "reviewer", "support", "draw_officer", "draw_approver", "fulfilment", "auditor", "platform_admin"],
  "draw.execute": ["draw_officer"],
  "draw.approve": ["draw_approver"],
  "draw.bundle": ["auditor", "draw_approver"],
  "winner.read": ["campaign_manager", "reviewer", "support", "draw_officer", "draw_approver", "fulfilment", "auditor", "platform_admin"],
  "winner.manage": ["fulfilment"],
  "winner.publish": ["fulfilment", "campaign_manager"],
  "support.handoff": ["support", "promotion_admin", "promotion_assistant"],
  "support.read": ["campaign_manager", "reviewer", "support", "draw_officer", "draw_approver", "fulfilment", "auditor", "platform_admin", "promotion_admin", "promotion_assistant"],
  "ops.read": ["platform_admin", "campaign_manager", "auditor", "support"],
  "ops.retry": ["platform_admin", "support"],
  "ops.alerts.ack": ["platform_admin", "support", "campaign_manager"],
  "settings.write": ["platform_admin"],
  "audit.read": ["auditor", "platform_admin"],
  "report.read": ["campaign_manager", "reviewer", "support", "draw_officer", "draw_approver", "fulfilment", "auditor", "platform_admin", "promotion_admin", "promotion_assistant"],
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
/** The roles that hold a permission, for the console to say WHY a control is missing. */
export function rolesFor(permission: Permission): readonly Role[] { return PERMISSIONS[permission]; }
/** Staff/role/resource matrix for documentation. */
export function permissionMatrix() { return Object.entries(PERMISSIONS).map(([permission, roles]) => ({ permission, roles: [...roles] })); }
