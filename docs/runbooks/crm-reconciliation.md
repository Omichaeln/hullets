# CRM reconciliation

Alert: `crm.delivery` (permanent failure or unknown outcome).

1. Ops → CRM sync: filter by status. `retryable_failure` clears itself; `unknown_outcome` means we wrote but did not get a confirmation; `permanent_failure` includes "superseded" rows, which are expected when a newer version was delivered first.
2. Click **Reconcile with vendor**: every failed/unknown event is compared with the vendor's stored version; matching versions become `reconciled`, unknowns are requeued, real differences are listed.
3. Retry individual events after fixing credentials or the vendor endpoint. Entries and winners are never affected by CRM state.
4. When the vendor is chosen (D-19), map the contract in a new adapter class; the canonical records (`crm-map/1`) stay the same.
