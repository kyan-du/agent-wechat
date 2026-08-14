CREATE TABLE IF NOT EXISTS outbound_idempotency_seq (
    key TEXT PRIMARY KEY,
    generation INTEGER NOT NULL
);

INSERT INTO outbound_idempotency_seq (key, generation)
SELECT key, generation
FROM outbound_idempotency
WHERE true
ON CONFLICT(key) DO UPDATE SET
    generation = MAX(outbound_idempotency_seq.generation, excluded.generation);
