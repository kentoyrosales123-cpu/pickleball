# CourtSide — Pickleball Management System

A Node.js/Express application with MongoDB transactions, JWT authentication, Socket.IO, and a responsive Bootstrap/vanilla JavaScript interface. Includes player and administrator dashboards, the 12 requested skill categories, event registration and waitlists, team drafts, match schedules, four tournament formats, official scoring, statistics, notifications, and audit history.

## Quick local preview

Requires Node.js 22 or later and Windows, macOS, or Linux supported by MongoDB. Node 24 is used for this project.

```powershell
npm.cmd ci
npm.cmd run preview
```

Open <http://localhost:3000>. On Windows, `npm.cmd` works even when PowerShell blocks `npm.ps1`. On macOS/Linux use `npm`.

The preview starts an **actual isolated MongoDB replica set**, creates an administrator, and seeds 24 players across all 12 skill levels plus two open-play events and one tournament. It does not replace database integration with fixtures. On first run, `mongodb-memory-server` downloads MongoDB 7.0.14 (approximately 592 MB on Windows); the binary is cached in `.cache/mongodb-binaries`. The preview database is temporary and is discarded when stopped. Use the persistent setup below for real club records.

The local administrator uses `ADMIN_EMAIL` and `ADMIN_PASSWORD` from the ignored `.env` file. The requested email is configured locally; the password is never included in this README or committed source. Without those variables, preview generates a random administrator password. Set `PREVIEW_PASSWORD` to an explicit value if using the default email. Seed player passwords use `SEED_PASSWORD` when supplied, otherwise a separate random value. No credentials are returned by the API.

## Persistent MongoDB / Atlas setup

1. Create an Atlas database user and configure Atlas network access for your development host. A local MongoDB **replica set** also works; a standalone MongoDB server does not support this application's transactions.
2. Use `.env.example` as the configuration reference. If `.env` already exists with your administrator credentials, preserve it and add the remaining variables rather than overwriting it.
3. Set `MONGODB_URI`, `APP_URL=http://localhost:3000`, and a randomly generated `JWT_SECRET` of at least 32 characters. Generate a secret with:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

4. With `NODE_ENV=development`, provision the first administrator, optionally seed development data, then start:

```powershell
npm.cmd run create-admin
npm.cmd run seed
npm.cmd run dev
```

`create-admin` uses `ADMIN_EMAIL` and `ADMIN_PASSWORD`, hashes the password with bcrypt, and refuses to run outside development or when an administrator already exists. Development bootstrap accepts an explicitly chosen password of 8–72 UTF-8 bytes; player registration and password reset require at least 12 characters. `seed` requires a `SEED_PASSWORD` of at least 12 characters and refuses to run outside development. Remove bootstrap and seed passwords from production environment configuration. The application never creates a default production administrator.

Seed data is idempotent by username and event name. Emails are `player1@example.test` through `player24@example.test`. Seeded events start relative to the seed date. The seed does not erase existing club data.

## Email

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM`. Port 465 uses implicit TLS; port 587 uses the SMTP transport's STARTTLS negotiation. Without SMTP in development, verification and reset links are printed only to the development server console. Production startup requires SMTP host/from configuration and an HTTPS `APP_URL`.

Verification and reset tokens expire after one hour, are stored as SHA-256 digests, and are consumed atomically. Reset invalidates existing sessions. Verification status is visible on the player profile; it currently does not restrict event registration. Registration signs a player in immediately, as requested.

## Club workflow

1. Players register with an initial provisional level, then sign in to their dashboard. Profile supports optional gender/date of birth and a hosted HTTPS image URL. Administrators confirm skill levels with a reason; every confirmation creates ranking history and an audit entry. Automatic doubles ranking can be enabled by an administrator; see the rating-engine guide below.
2. Administrators create an event with dates, ranking limits, capacity, courts, format, and scoring rules. Use `registration-open` to accept registrations during its configured registration window. Draft events remain hidden from players. Registration closes according to the deadline even if the displayed status has not been manually changed.
3. Players register or join the waiting list. Administrators can also add/remove participants. Cancellation before the deadline promotes the earliest waiting player automatically. Capacity, duplicate checks, promotion, and draft invalidation share a transaction and serialize on the event document.
4. In an event's **Teams** tab, generate random, ranking-balanced, or similar-rank teams. Administrators can manually assign or swap players with dropdowns. Save draft adjustments before finalizing. Odd players remain visible as substitutes; explicit confirmation is required to finalize with unassigned players. For player-selected teams, confirmed participants submit preferred partners and administrators approve them into a draft.
5. Finalization publishes the teams and locks the roster. Reopening an official assignment requires confirmation and clears the schedule; it is permitted only before any official match results exist. This prevents regeneration from silently replacing official assignments.
6. In **Matches**, publish a schedule or bracket. Administrators enter official scores for a single game or best of three, using the configured target and winning margin. Each doubles result counts for both teammates. Concurrent duplicate submissions do not duplicate statistics. Stale edits are rejected with HTTP 409.
7. Corrections replace the authoritative finalized result. If advancement has already been scored, an explicit cascade correction clears affected downstream results and the old champion. The bracket is recalculated, statistics immediately reflect the revised finalized records, and the previous bracket is preserved in an audit entry.

### Scheduling and tournament rules

- Open play supports random matches, strength-balanced matchups, full round robin, and rotating partners. `rounds` applies to random/balanced/rotating schedules; full round robin plays each pair once.
- Rotating partners chooses the least-used players first when court-ready groups require byes, optimizes new partnerships, and reduces repeated opponents. Every active round uses complete four-player matches; substitutes rotate in across rounds.
- A schedule reserves named courts and avoids overlapping team/player assignments. Administrators can change an unplayed match?s court and time; the server checks overlaps, dependencies, and the event window. Fixed team rosters contain each player only once. Open-play schedules must fit inside the event window.
- Single elimination pads to a power of two and advances byes without counting them as played matches.
- Double elimination includes winners' and losers' brackets and an optional grand-final reset when the losers' bracket winner wins the first final.
- Group stage uses randomized groups with at least two teams, then advances the top two per group into knockout. Group ordering uses wins, point differential, points scored, then stable team ID to resolve an exact tie. This tie rule is displayed in the interface.
- Tournament matches receive courts/times as their participants become known. The allocator uses available courts without overlapping teams and waits for dependencies; knockout starts after the group stage. A conservative serial-duration bound is required at generation time to guarantee that even the reset fits in the event window. This can require a longer event window than an optimized all-court schedule would need.
- Tournament standings and champions update transactionally after results. Administrators mark an event completed when club operations are finished.
- Skill numbers are an approximate balancing heuristic. Optimization is randomized and aims to reduce imbalance; it is not a claim that skill intervals measure exact playing strength.
- Fees are recorded in PHP. The specification did not request a payment gateway; payment collection is handled by the club.

## Competitive star rankings

The **Ranked clubhouse** adds Rookie-to-Legend stars, protection and double-star meters, hidden competitive MMR, ranked leaderboards, season resets, and audited corrections. It reuses existing user accounts, event registration, team editing, brackets, scoring, and JWT roles. See [star-ranking.md](docs/star-ranking.md) for rules, APIs, migrations, workflow, verification, and deployment limits. The existing skill-category Elo described below remains separate.

Open play events and tournaments have a **Rankings** tab. Enable **Enable rankings for this event** in event setup before recording results. Standings show event-only net stars, wins, losses, and win rate alongside current club rank; finalized ranked matches count, and corrections recalculate standings. The API is `GET /api/ranking/leaderboard?period=event&eventId=EVENT_ID` (paginated).

## Automatic player ranking

The doubles Elo engine integrates with official results, team balancing, leaderboards, and the player dashboard. It defaults to disabled for existing clubs. See [automatic-ratings.md](docs/automatic-ratings.md) for enabling it, the K=32 algorithm, ten-match confirmation, hysteresis, manual overrides, replay semantics, migration, and API payloads. The versioned migration runs on server startup; `npm.cmd run migrate` is also available for a configured persistent database.

New files: `src/domain/ratings.js` (pure Elo/replay), `src/services/ratings.js` (transactional ledger and caches), `src/controllers/ratings.js` (rating APIs), `src/migrations/001-doubles-ratings.js` (safe backfill), `scripts/migrate.js` (migration CLI), `public/js/ratings.js` (dashboard/settings/override UI), and `test/ratings*.test.js` (unit and real-database tests).

## Source architecture and file purposes

| File                                 | Purpose                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `package.json` / `package-lock.json` | Runtime commands, pinned dependency graph, and development tools.                                                    |
| `.env.example`                       | Non-secret configuration reference.                                                                                  |
| `.gitignore`                         | Excludes credentials, dependencies, logs, and downloaded test binaries.                                              |
| `render.yaml`                        | Render web-service configuration and required deployment environment variables.                                      |
| `src/config.js`                      | Validates environment variables and production prerequisites.                                                        |
| `src/server.js`                      | Connects MongoDB, starts HTTP/Socket.IO, authenticates sockets, and shuts down cleanly.                              |
| `src/app.js`                         | Express composition, CSP/Helmet, CORS, rate limiting, CSRF request checks, static assets, and health check.          |
| `src/models/index.js`                | Mongoose schemas, references, indexes, ranking labels, and database initialization.                                  |
| `src/middleware/security.js`         | JWT/session validation, administrator checks, public user serialization, request validation, and safe errors.        |
| `src/routes/api.js`                  | REST routes and their authentication, role, and schema requirements.                                                 |
| `src/controllers/auth.js`            | Registration/login/logout, verification, and password-reset operations.                                              |
| `src/controllers/events.js`          | Event lifecycle, registrations, teams, partner approvals, schedules, brackets, and official results.                 |
| `src/controllers/players.js`         | Profiles, rankings, membership status, leaderboards, reports, settings, and notifications.                           |
| `src/services/registration.js`       | Transactional roster capacity, waiting-list promotion, and draft invalidation.                                       |
| `src/services/teams.js`              | Secure random shuffling, randomized team optimization, round robin, rotating matchups, and court scheduling.         |
| `src/services/brackets.js`           | Tournament graph generation, byes, winners/losers advancement, reset finals, standings, and correction invalidation. |
| `src/services/scoring.js`            | Validates point targets, winning margins, best-of-three series, and impossible final scores.                         |
| `src/services/stats.js`              | Derives statistics and chronological histories from finalized matches.                                               |
| `src/services/notifications.js`      | Persists player notifications and administrator audit records; signals clients after commit.                         |
| `src/services/mail.js`               | Expiring action tokens and SMTP delivery.                                                                            |
| `public/index.html`                  | Accessible application entry point with locally served vendor assets.                                                |
| `public/css/app.css`                 | Responsive navy/green sports interface, forms, tables, charts, and bracket layouts.                                  |
| `public/js/api.js`                   | Same-origin API requests, HTML escaping, UI helpers, and CSV export.                                                 |
| `public/js/app.js`                   | Landing page, authentication views, role-aware navigation, dashboards, profiles, charts, and reports.                |
| `public/js/events.js`                | Event forms and event workspace: roster, team drafts, partner approval, bracket, and score entry.                    |
| `scripts/create-admin.js`            | Development-only first-administrator provisioning.                                                                   |
| `scripts/seed.js`                    | Development sample players and events persisted in MongoDB.                                                          |
| `scripts/preview.js`                 | Disposable local replica set and seeded development preview.                                                         |
| `test/domain.test.js`                | Algorithm invariants, scoring, scheduling, and elimination topology tests.                                           |
| `test/integration.test.js`           | Real replica-set API/concurrency/security tests and DOM-to-API workflow checks.                                      |

### Data model

The requested `User`, `Event`, `EventRegistration`, `Team`, `Match`, `Tournament`, `PlayerRankingHistory`, `Notification`, and `AuditLog` models are implemented, with `ActionToken`, `Settings`, and `TeamProposal` supporting authentication/configuration/player partner choices. Users have unique username/email indexes; registrations have a unique `(eventId,userId)` index; tournament event references and match bracket keys have unique indexes; action tokens have TTL expiration. Password hashes and token versions are excluded from normal queries and never included in API responses.

Statistics intentionally use finalized match records as their authoritative source, rather than maintaining fragile increment/decrement counters. This makes resubmissions and corrections consistent for every player. The current leaderboard calculates per-player statistics in application code and is suitable for a small club; larger organizations should replace repeated full-history scans with indexed aggregation or transactionally rebuilt materialized views.

## API

All `/api` JSON mutations require the `X-PMS-Request: 1` header. The web client adds it automatically. Sessions use an HTTP-only, SameSite=Strict cookie with an eight-hour JWT; production cookies are Secure. Cross-origin mutation requests are rejected. Administrators cannot be self-selected during registration.

| Area             | Routes                                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public           | `GET /api/rankings`, `GET /api/public/events`, `GET /health`                                                                                                                                                          |
| Authentication   | `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`                                                                                                                        |
| Account recovery | `POST /api/auth/forgot-password`, `POST /api/auth/action`, `POST /api/auth/resend-verification`                                                                                                                       |
| Player           | `GET/PUT /api/players/me`, `GET /api/players/me/stats`, `GET /api/players/me/matches`, `GET /api/players/me/rankings`, `GET /api/leaderboard`                                                                         |
| Events           | `GET/POST /api/events`, `GET/PUT/DELETE /api/events/:id`, `POST/DELETE /api/events/:id/register`                                                                                                                      |
| Roster (admin)   | `GET/POST /api/events/:id/participants`, `DELETE /api/events/:id/participants/:userId`                                                                                                                                |
| Teams            | `GET/PUT /api/events/:id/teams`, `POST /api/events/:id/generate-teams`, `POST /api/events/:id/finalize-teams`, `POST /api/events/:id/reopen-teams`                                                                    |
| Partners         | `GET/POST /api/events/:id/partner-requests`, `PUT /api/events/:id/partner-requests/:proposalId`                                                                                                                       |
| Matches          | `POST /api/events/:id/generate-matches`, `GET /api/events/:id/matches`, `POST/PUT /api/matches/:id/results`, `PUT /api/matches/:id/schedule`                                                                          |
| Tournaments      | `POST /api/tournaments/:id/generate-bracket`, `GET /api/tournaments/:id/bracket`, `GET /api/tournaments/:id/standings`                                                                                                |
| Administration   | `GET /api/admin/dashboard`, `GET /api/admin/players`, `PUT /api/admin/players/:id/ranking`, `PUT /api/admin/players/:id/active`, `GET /api/admin/reports`, `GET /api/admin/audit-logs`, `GET/PUT /api/admin/settings` |
| Notifications    | `GET /api/notifications`, `PUT /api/notifications/:id/read`                                                                                                                                                           |

Only administrators can mutate event definitions, other players' registrations, team assignments, match schedules, official results, rankings, or settings. Participant roster access is administrator-only; confirmed players may see minimal partner options in player-selected events. Notifications are filtered to the signed-in user. Event and user identity come from authenticated sessions and server-side lookup, not client-supplied role fields.

## Tests and validation

```powershell
npm.cmd test
npm.cmd audit
npm.cmd run format:check
```

Tests start a separate disposable MongoDB replica set; they never use `MONGODB_URI` or change your club database. They cover registration concurrency with and without waitlists, duplicate registrations, eligibility, session revocation, password-reset token reuse, role authorization, private notifications, team finalization/reopening, score validation, result idempotency and correction, bracket byes/advancement/reset, partner approvals, court allocation, and DOM controls backed by actual API calls. Algorithm tests exercise double-elimination team counts from 2 through 24.

The DOM test checks controls and server-backed workflows; it does not measure visual layout. Browser automation was unavailable during initial development, so a desktop/mobile visual review remains a deployment check. SMTP delivery and a live Atlas/Render deployment require your environment configuration and have not been tested against your accounts.

## Render and GitHub deployment

1. Create a private GitHub repository and push this directory, excluding `.env`, `node_modules`, and `.cache`. Review `git status` before committing credentials or any local files.
2. Provision the first administrator against the intended Atlas database from a trusted development environment using `create-admin`. Do not seed sample accounts into a live club database.
3. Connect the GitHub repository to Render and select the included Blueprint, or configure a Node web service with `npm ci --omit=dev` and `npm start`.
4. Set `MONGODB_URI`, `APP_URL` to the final HTTPS Render URL, the SMTP settings, and a strong `JWT_SECRET`. Render Blueprint generates the JWT secret. Use the Render-provided `PORT`.
5. Configure Atlas network access for the Render service. Deploy, check `/health`, sign in, and verify an email round trip before opening registration.
6. Confirm Atlas backups, indexes, TLS, and club-data retention settings appropriate to your operations. The checked-in Render configuration does not provision an Atlas account or send production email automatically.

Start with **one web-service instance**. Rate limits are currently per process and Socket.IO uses its in-process adapter. Multiple instances require a shared rate-limit store and Socket.IO adapter. The app trusts one reverse proxy in production, matching a normal Render web-service deployment.

No GitHub push or public deployment is performed automatically. The repository contains working application source and deployment configuration; production account configuration, SMTP verification, browser visual review, and operational acceptance are still required before calling a live deployment production-ready.

Implementation references: [Mongoose transactions](https://mongoosejs.com/docs/transactions.html) and [Express production security](https://expressjs.com/advanced/best-practice-security/).

### Render origin and proxy configuration

The app detects Render through `RENDER=true` and trusts one proxy hop even if `NODE_ENV` was accidentally set to development. Keep `NODE_ENV=production` for secure cookies and production validation; SMTP configuration is still required in production.

`APP_URL` is normalized to its origin, so a trailing slash or pasted login path does not break login. On Render, a missing or localhost `APP_URL` falls back to `RENDER_EXTERNAL_URL`. The configured origin and the service's Render origin are allowed consistently for API requests and Socket.IO. Other origins remain blocked. Set `APP_URL` to your canonical HTTPS domain for email links.

The repository selects Node 24. An explicit Render `NODE_VERSION` takes precedence, so remove an override or set it to `24`. Atlas network access must still allow the service's outbound IP ranges; application changes cannot modify Atlas access rules.

## Live random queue

For the court-and-waiting-list workflow, create an open-play event with **Random queue (new teams every round)** and open its **Live queue** tab as an administrator. Add confirmed participants through **Add player**, then select **Add match** to reserve the next four players and randomize their teams. Choose a free court and select **Call Players**. The blue/orange winner buttons ask for actual game scores; saving updates results and returns all four players to the waiting queue. Fewest games are prioritized, followed by longest waiting time. Pairings can repeat by chance.

Up Next matches persist across refreshes and can be released back to the queue. Live courts cannot be double-booked. This workflow is separate from publishing a fixed schedule: use an event without an existing schedule, and skip team finalization. Existing scheduled events are preserved. The queue currently uses fair rotation, not winner/loser priority groups.

## Account roles

- **Super Admin** creates accounts, assigns Player/Admin/Super Admin roles, activates or deactivates users, manages club settings and rankings, and manages events.
- **Admin** creates and manages events, rosters, queues, teams, schedules and results. Admins cannot create accounts, change roles, deactivate users, or change global settings. The roster picker exposes player names and skill levels without account emails.
- **Player** registers for events and views personal results and club information. Public signup always creates a Player.

Sign in as Super Admin and open **User management** to create an account with a chosen role or use **Change role** beside an existing user. Role changes invalidate that user's sessions. You cannot change your own role or deactivate yourself, and at least one active Super Admin is preserved.

On server startup, migration `003-super-admin` promotes the oldest active legacy Admin if no active Super Admin exists. It runs once; newly created Admin accounts are never automatically promoted. The development bootstrap now creates a Super Admin. Restart the server after updating, then refresh or sign in again to see the new navigation. The migration can also be run with `npm.cmd run migrate` against your configured database.
