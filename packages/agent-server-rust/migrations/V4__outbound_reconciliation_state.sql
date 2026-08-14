PRAGMA foreign_keys = OFF;

CREATE TABLE outbound_idempotency_v4 (
    key TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (
        state IN ('queued', 'sending', 'sent', 'uncertain', 'failed', 'rejected', 'expired', 'needs_reconciliation')
    ),
    result_success INTEGER,
    error_code TEXT,
    error TEXT,
    commit_attempted INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
);

INSERT INTO outbound_idempotency_v4
    (key, state, result_success, error_code, error, commit_attempted, expires_at, created_at, updated_at, completed_at)
SELECT key, state, result_success, error_code, error, commit_attempted, expires_at, created_at, updated_at, completed_at
FROM outbound_idempotency;

DROP TABLE outbound_idempotency;
ALTER TABLE outbound_idempotency_v4 RENAME TO outbound_idempotency;

CREATE INDEX IF NOT EXISTS idx_outbound_idempotency_state
    ON outbound_idempotency(state);

CREATE INDEX IF NOT EXISTS idx_outbound_idempotency_expires_at
    ON outbound_idempotency(expires_at);

PRAGMA foreign_keys = ON;
