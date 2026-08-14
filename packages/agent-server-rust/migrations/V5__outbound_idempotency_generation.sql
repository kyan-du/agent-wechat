ALTER TABLE outbound_idempotency
    ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
