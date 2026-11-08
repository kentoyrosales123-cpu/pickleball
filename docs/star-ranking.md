# Competitive star rankings

The **Ranked clubhouse** navigation item adds competitive progression to the existing website. Existing authentication, twelve skill categories, event eligibility, registration, partner approval, brackets, scheduling, and official result workflows remain in place. The older optional doubles Elo system remains separate: its enable switch does not disable competitive stars.

## Club workflow

1. Register normally. A linked `PlayerRanking` starts at Rookie III, zero stars, 1000 hidden MMR. The registration skill-level selector continues to mean the existing club skill category, not a starting competitive rank.
2. Create an Open Play or Tournament event and select **Ranked doubles matches**. Existing events retain their existing rated/unrated flag.
3. Register participants. In Ranked clubhouse, select an event and confirmed players, choose waiting priority, and generate a court preview. Save the team draft and open the event workspace to adjust, finalize, and publish the schedule. The saved draft contains partnerships; the event scheduler determines the final opponents, courts, and times according to the event format. Preview court assignments are advisory.
4. Existing balanced team generation uses the competitive MMR for rated events. Four players evaluate all three pairings. Larger events use the existing randomized optimizer; the separate court preview groups nearby ratings and evaluates each quartet. These are heuristics for larger pools, not a global exhaustive optimizer. Rotating event schedules distribute appearances and discourage repeated partners. Manual/player-selected tournament partnerships cannot be automatically regenerated; seeded/manual teams use the existing editor.
5. Enter scores in the event match workspace. Existing target, margin, best-of, revision, bracket, and overlap checks apply. Finalized ranked results atomically update both ranking systems as applicable.
6. Correct a ranked score through **Correct result**, with a reason. A correction replays later results, including opponents and partners, reward meters, streaks, and season snapshots. Descendant tournament results require the existing explicit cascade workflow.
7. Ranked clubhouse shows standings, profiles, stars, meters, recent results, and administrator controls. The original club leaderboard remains available separately.

## Rules and privacy

- Nine tiers from Rookie through Grandmaster each have III, II, I divisions, five stars per division. Legend begins at 135 cumulative stars and has unlimited additional stars.
- Default win/loss: +1/-1 star, floored at zero. Wins earn double-star points and losses earn protection points: 20 normally, 30 when the opposing pre-match team average is at least 150 MMR higher. At 100 points a win gains another star or a loss loses no star; excess points carry over.
- Competitive Elo starts at 1000. Both partners use the same team-average expected score, with each player's K=40 for their first ten placement matches and K=24 thereafter. MMR has no visible star-based floor.
- Star-system MMR and history values are omitted from player API responses by default. Team combined MMR is also omitted. Administrators can enable visibility with an audited reason. The old skill-system Elo is a separate existing public value and remains backward compatible.
- Monthly standings measure net match stars earned in the UTC calendar month. Current rank standings include manual rank assignments and season resets. All-time match stars exclude manual assignments and season resets. Sorting uses stars, hidden MMR, wins, then stable player ID.
- Manual rank changes require a reason and create replayable adjustment records; they do not modify MMR or reward meters.

## Pickle Que rank reviews

Administrators can open **Player management → Pickle Que rank review**, or **Ranked clubhouse → Pickle Que review** next to a player. Enter the HTTPS profile link, external account name, date checked, wins and losses, optional displayed rating/level, and supporting notes. Win rate and match count are calculated from wins/losses. Stats are manually entered and attested by the administrator; the app does not retrieve or independently verify them with Pickle Que.

Choose a competitive tier, division, and stars, explain why the stats justify that rank, confirm the account belongs to the player, and review the before/after confirmation before saving. Non-Legend divisions accept 0–4 stars; Legend accepts unlimited stars up to the application's cumulative-star safety bound. The server converts the selected rank into cumulative stars. There is no invented conversion from external rating or win percentage: the administrator makes the assessment.

Each review stores its evidence, actor, timestamp, previous stars, assigned stars, and reason on the immutable ranking adjustment and in the audit log. **Previous Pickle Que reviews** shows paginated review history with source links. Evidence and review endpoints are administrator-only; players receive a rank-change notification and can see their normal ranking history. Reviews adjust visible competitive rank; they do not import external wins/losses into club statistics, change MMR or reward meters, or replace the existing twelve skill categories.

`GET /api/admin/ranking/players/:id/pickle-que-review?page=1` returns the current rank/version and prior reviews. `POST` to the same path requires `expectedVersion`, `targetRank: {tier, division, stars}`, `stats: {profileUrl, accountName, observedOn, wins, losses, displayedRating?, notes?}`, `reason`, and `confirmed: true`. The shared ranking transaction lock and version check reject duplicate or stale reviews with HTTP 409. Ordinary players cannot read or submit reviews. URLs must use HTTPS without embedded credentials; URLs are stored as evidence, never fetched by the server.

Deployment: restart the Node server to load the new routes/models and refresh the browser. This adds an optional `RankingAdjustment.externalReview` subdocument, so no data migration or backfill is required. Implementation: `src/controllers/pickle-que.js`, `src/models/ranking.js`, `src/routes/ranking.js`, `public/js/pickle-que.js`, player/leaderboard UI hooks and CSS. Integration tests cover evidence persistence, rank conversion, privacy/authorization, validation, concurrent review protection, and the form-to-API flow.

## Season lifecycle

Administrators start a season immediately with an end date, rule snapshot, reason, and reset policy. Starting another season closes the previous one and archives its final rank, highest rank, and state. Corrections may legitimately update archived standings; prior changed ledger states remain in audit records.

Policies: **none** retains stars/MMR; **partial** retains the configured fraction of stars, rounded down; **placement** resets stars to zero, moves MMR halfway to 1000, and restarts placement K. Both reward meters reset at season start. Lifetime wins, losses, ranked-match counts, highest rank, and longest streak are preserved. Rule changes apply to the new season; each match retains its captured rules for replay.

After a season's end date, new matches are outside that season and use default rules until an administrator starts another. No scheduler silently starts seasons. Season end processing occurs on the next ranking replay; the UI displays a past end date as ended. Historic season filters use archived states and season-specific match statistics.

## API

All routes require the existing JWT session cookie. Mutations also require `X-PMS-Request: 1`. Existing request-origin checks and rate limiting apply. Administrative routes enforce the existing administrator role.

| Method and path                           | Purpose                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| `GET /api/ranking/leaderboard`            | `period=current                                                                   | month         | season | all-time`, `seasonId`, `eventId`, `tier`, `search`, `page`, `limit` |
| `GET /api/ranking/players/:id`            | Public rank profile; MMR follows visibility policy                                |
| `GET /api/ranking/players/:id/history`    | Before/after ranking history, `page`, optional `seasonId`                         |
| `GET /api/ranking/players/:id/statistics` | Wins/losses, games, streaks, recent results                                       |
| `GET /api/ranking/seasons`                | Season list and rule snapshots                                                    |
| `POST /api/ranking/matchmaking/preview`   | Admin: `eventId`, unique `playerIds`, `rotation=least-played                      | registration` |
| `POST /api/ranking/matches/:id/finalize`  | Admin: `scores: [{a,b}]`, `revision`; duplicate same results are idempotent       |
| `POST /api/ranking/matches/:id/correct`   | Admin: same fields, required `reason`, optional `cascadeCorrection`               |
| `PATCH /api/admin/ranking/players/:id`    | Admin: `rankStars`, required `reason`                                             |
| `GET /api/admin/ranking/settings`         | Admin: visibility, default rules, tiers                                           |
| `PATCH /api/admin/ranking/settings`       | Admin: `showMMR`, required `reason`                                               |
| `POST /api/admin/ranking/seasons`         | Admin: `name`, `endDate`, `resetPolicy`, `keepFraction`, `rankingRules`, `reason` |

Use existing `/api/events/:id/teams` and scheduling routes to save/publish assignments. Ordinary users cannot supply stars, MMR, or meter values through any ranking mutation route.

## Storage and consistency

`PlayerRanking.userId` references the existing User, with a unique index. Its `state` contains rankStars, lifetimeStars, tier/division, MMR, meters, statistics, highest ranks, and season ID; `version` tracks rebuilds. `RankingHistory` has a unique `(playerId,sourceId)` constraint, which is stricter than one entry per player/match/season. Nested `before` and `after` preserve the full state rather than separate duplicated columns.

`RankingSeason`, `SeasonRanking`, and `RankingAdjustment` store season policy, final/current season snapshots, and immutable manual decisions. Matches add `starPolicy`, `rankingSeasonId`, `rankingApplied`, `rankingVersion`, and `finalizedBy`, while retaining the existing status/revision fields.

Every result-affecting transaction acquires the existing shared settings revision lock. Match revisions protect stale updates. The replay and match/bracket/statistics updates commit together. Replaced/reversed ledger entries retain their previous states in `AuditLog`. Socket.IO emits `ranking:result` to authenticated player rooms and `ranking:leaderboard-changed` only after commit; persisted notifications support refresh/reconnect. Socket signals are best-effort refresh hints, not a durable delivery queue.

The rollback tests also exposed and fixed a Mongoose transaction-reset issue: embedded score and rating-policy schemas explicitly disable subdocument version keys, preserving the original failure instead of masking it with a strict-schema error.

## Migration and deployment

1. Back up the persistent database before deployment. Use MongoDB Atlas or a replica set; standalone MongoDB cannot provide the required transactions.
2. Configure **`.env`**, not `.env.example`, with `MONGODB_URI` and a random `JWT_SECRET` of at least 32 characters. Keep `.env` out of source control. Production also requires HTTPS `APP_URL` and SMTP configuration.
3. Run `npm.cmd run migrate` (or `npm run migrate` outside PowerShell). Server startup also runs migrations. `002-star-ranking` creates missing Rookie profiles without replaying historical results or overwriting skill ratings. It is idempotent.
4. Restart with `npm.cmd start`. Check `/health` returns `{"status":"ready"}`. For a disposable local database, use `npm.cmd run preview`; preview data is discarded when stopped.
5. Create a season if desired, enable ranked event flags, and verify a test event before club use. Historical results gain star effects only when explicitly reverified/opted in; migration does not silently award historical stars.

No additional dependencies are required. Full replay currently scans the club's ranking history inside the transaction, and leaderboard filtering is performed in memory. This favors correctness for a small club; production at large scale requires performance measurement and checkpointed replay/indexed aggregation. Do not assume large-league throughput has been tested.

## Verification and files

`npm.cmd test` covers the existing workflows plus ranking arithmetic, protection/bonus carryover, division and Legend boundaries, placement K, doubles balance, real replica-set concurrency/idempotency, invalid scores, write-failure rollback, correction replay, privacy/authorization, season archives, draft persistence, and DOM-to-API dashboard rendering. Tests use disposable MongoDB databases, not the configured persistent database.

Added: `src/domain/ranking.js`, `src/models/ranking.js`, `src/services/ranking.js`, `src/routes/ranking.js`, `src/migrations/002-star-ranking.js`, `public/js/ranking.js`, `test/ranking.test.js`, `test/ranking.integration.test.js`, and this guide.

Updated: existing auth/event controllers, models/index, routes/api, domain/ratings, services/teams and notifications, server/migration entry points, public app/events JavaScript and CSS, configuration diagnostics, `.env.example`, and README. Local `.env` is private deployment configuration.

Browser-based visual inspection could not be completed in this environment because no browser/native automation surface was available. Responsive CSS and real-API DOM behavior were checked; desktop/mobile visual acceptance and production load testing remain deployment checks.
