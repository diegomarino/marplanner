-- Synthetic supported v2 baseline immediately before the lifecycle migration.
CREATE TABLE `drizzle_universe_migrations` (
  `fileName` TEXT PRIMARY KEY NOT NULL,
  `appliedAt` INTEGER NOT NULL
);

INSERT INTO `drizzle_universe_migrations` (`fileName`, `appliedAt`)
VALUES ('0000_current_baseline.sql', 1790504130000);
