# Incident response

Controls, all immediate and audited (Campaigns → Overview & controls): pause intake (participants are told), pause automatic qualification (everything goes to review), pause outbound (messages queue), pause draws (freeze refused). Campaign status `paused` stops entries but keeps information menus.

1. Contain: apply the relevant control; for a suspected data exposure disable the affected staff user (Access) which revokes sessions.
2. Preserve evidence: sign an audit checkpoint (Audit → Sign checkpoint); export the relevant records (auditor); keep alert ids and correlation ids.
3. Communicate: the participant-facing copy for paused intake and delays is already in the campaign content; use Support → send only through claimed conversations.
4. Recover: fix, replay dead letters, retry outbound/CRM as the runbooks describe, release the controls, verify the audit chain.
5. Review: record decisions in the campaign's client decisions or in the audit log via evidence records.
