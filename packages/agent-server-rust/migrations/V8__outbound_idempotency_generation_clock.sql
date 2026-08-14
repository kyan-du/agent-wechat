CREATE TABLE IF NOT EXISTS outbound_idempotency_clock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_generation INTEGER NOT NULL
);

INSERT INTO outbound_idempotency_clock (id, next_generation)
SELECT 1, COALESCE((
    SELECT MAX(g) FROM (
        SELECT MAX(generation) AS g FROM outbound_idempotency
        UNION ALL
        SELECT MAX(generation) AS g FROM outbound_idempotency_seq
    )
), 0) + 1
WHERE NOT EXISTS (SELECT 1 FROM outbound_idempotency_clock WHERE id = 1);

DROP TABLE IF EXISTS outbound_idempotency_seq;
