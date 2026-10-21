# Features

Start with the [feature tour](../guide/README.md) for screenshots and a walkthrough.
The files in this folder are the **behaviour specs** behind each feature: user
stories, requirements and edge cases. Each one links to the contract that owns its
invariants.

## For the family

| Feature            | What it does                                                                    | Tour                                                                  | Spec                                                                 | API                                            |
| ------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------- |
| Home dashboard     | Today's agenda, chores, meals and weather on the wall tablet                    | [1](../guide/README.md#1-home-today-at-a-glance)                      | [kiosk shell](kiosk-shell-navigation.md)                             | —                                              |
| Routines & chores  | Routines by part of the day, emoji chores, weekday assignments, streaks         | [2](../guide/README.md#2-routines-and-chores-with-streaks)            | [routines-chores](routines-chores.md), [day-periods](day-periods.md) | [chores](../api/README.md#domains)             |
| Meals & recipes    | Recipe catalogue, repeating meal plans, one-off meals, a menu built when viewed | [3](../guide/README.md#3-meals-and-recipes)                           | [meals-recipes](meals-recipes.md)                                    | [meals](../api/README.md#domains)              |
| Daily briefing     | A personal printed slip per member, built from 20+ content blocks               | [4](../guide/README.md#4-daily-briefing-printed-on-a-thermal-printer) | [daily-briefing](daily-briefing.md)                                  | [daily-briefing](../api/README.md#domains)     |
| Printing           | ESC/POS over Web Bluetooth from the kiosk browser                               | [4](../guide/README.md#4-daily-briefing-printed-on-a-thermal-printer) | [printing](printing.md)                                              | [printing](../api/README.md#domains)           |
| Calendar           | Local events plus ICS feeds, member assignment, emoji highlights                | [5](../guide/README.md#5-shared-calendar-and-ics-feeds)               | [calendar](calendar.md)                                              | [calendar](../api/README.md#domains)           |
| Reminders          | Repeating or calendar-dependent prompts that go into the briefing               | [6](../guide/README.md#6-reminders-and-daily-messages)                | [reminders](reminders.md)                                            | [reminders](../api/README.md#domains)          |
| Daily messages     | A sticky note for one member on one date                                        | [6](../guide/README.md#6-reminders-and-daily-messages)                | [daily-messages](daily-messages.md)                                  | [daily-messages](../api/README.md#domains)     |
| Time announcements | The tablet says the time out loud at set times                                  | [7](../guide/README.md#7-spoken-time-announcements)                   | [time-announcements](time-announcements.md)                          | [time-announcements](../api/README.md#domains) |
| Network devices    | Block or restore a device's internet access through UniFi                       | [8](../guide/README.md#8-network-devices-unifi)                       | [network-devices](network-devices.md)                                | [network-devices](../api/README.md#domains)    |
| Weather            | Open-Meteo pill and briefing block                                              | [9](../guide/README.md#9-weather)                                     | [weather](weather.md)                                                | [weather](../api/README.md#domains)            |

## For whoever runs it

| Feature         | What it does                                                               | Tour                                                         | Spec                                                      |
| --------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| Plugin system   | Optional features you switch on or off, each kept separate from the rest   | [10](../guide/README.md#10-plugins-turn-features-on-and-off) | [plugin-system](plugin-system.md)                         |
| Auth & sessions | Access gate, device provisioning, scoped keys, admin PIN                   | [11](../guide/README.md#11-security-for-a-kiosk)             | [auth-sessions](auth-sessions.md)                         |
| Members         | Profiles, roles, colours, birthdays, archiving                             | [11](../guide/README.md#11-security-for-a-kiosk)             | [members](members.md)                                     |
| Backups         | Snapshots, `.db`/SQL download, import, restore you can undo                | [12](../guide/README.md#12-backups-and-restore)              | [backups](backups.md)                                     |
| Settings        | Household language, timezone, week start, weather location                 | [14](../guide/README.md#14-english-and-spanish)              | [app-settings-registry](app-settings-registry.md)         |
| i18n            | English and Spanish, with a build check that keeps them in step            | [14](../guide/README.md#14-english-and-spanish)              | [i18n-localization](i18n-localization.md)                 |
| Scheduler       | Background jobs for syncing feeds, generating briefings and taking backups | —                                                            | [background-jobs-scheduler](background-jobs-scheduler.md) |
| Telemetry       | Diagnostics sent by the client, viewable in Admin → Logs                   | —                                                            | [client-logging-telemetry](client-logging-telemetry.md)   |
