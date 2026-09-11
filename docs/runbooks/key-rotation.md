# Key rotation

- `DATA_KEY` (identity encryption and fingerprints): rotation needs a re-encryption pass. Procedure: add a `DATA_KEY_PREVIOUS` variable and a migration tool that decrypts with the old key and re-encrypts with the new one for `participants.identity_enc` and `staff_users.mfa_secret_enc`, then recomputes `identity_fp`. This tool is not part of this repository; treat rotation as a planned change with a backup first.
- `AUDIT_SIGNING_KEY`: sign a checkpoint with the old key, rotate, sign a new checkpoint; keep the old key to verify historical checkpoints (the chain itself is key-independent).
- `META_ACCESS_TOKEN` and `CRM_TOKEN`: rotate in the secret store and restart; outbound rows in `retryable_failure` recover automatically.
- Staff sessions: disabling a user or changing roles revokes sessions immediately; `SESSION_HOURS` bounds their life.
