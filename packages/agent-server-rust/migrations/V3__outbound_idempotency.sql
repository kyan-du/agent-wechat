CREATE TABLE IF NOT EXISTS outbound_idempotency (
    key TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (
        state IN ('queued', 'sending', 'sent', 'uncertain', 'failed', 'rejected', 'expired')
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

CREATE INDEX IF NOT EXISTS idx_outbound_idempotency_state
    ON outbound_idempotency(state);

CREATE INDEX IF NOT EXISTS idx_outbound_idempotency_expires_at
    ON outbound_idempotency(expires_at);
