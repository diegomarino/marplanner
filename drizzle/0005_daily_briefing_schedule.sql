-- Per-member weekday pause for the daily briefing. NULL means every day; otherwise a JSON array
-- of canonical weekday codes (mon..sun) on which the member's briefing is generated and printed.
ALTER TABLE `daily_briefing_optin` ADD `weekdays` text;
