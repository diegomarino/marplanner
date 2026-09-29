-- Synthetic non-empty migration history outside the supported compatibility cohort.
CREATE TABLE `drizzle_universe_migrations` (
  `fileName` TEXT PRIMARY KEY NOT NULL,
  `appliedAt` INTEGER NOT NULL
);

INSERT INTO `drizzle_universe_migrations` (`fileName`, `appliedAt`)
VALUES ('0099_unknown_history.sql', 1790504130000);
