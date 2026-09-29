-- Synthetic fresh-install fixture.
-- Intentionally creates no migration journal or product data: the real migration runner must
-- classify the absence of prior history rather than infer state from any seeded contribution.
PRAGMA foreign_keys = ON;
