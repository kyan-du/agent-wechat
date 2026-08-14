CREATE INDEX IF NOT EXISTS idx_outbound_idempotency_cleanup
    ON outbound_idempotency(state, expires_at, updated_at);
