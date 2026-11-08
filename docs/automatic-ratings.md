# Automatic doubles ranking

The application now supports a club-defined doubles Elo engine. It is distinct from DUPR or any federation's rating. Singles are not currently supported; rating APIs accept only the `doubles` pool, and profiles/history use a unique `(playerId,pool)` key so another discipline cannot share doubles results accidentally.

## Enable locally

1. Stop the running app with **Ctrl+C** and restart with `npm.cmd run preview` (temporary database) or `npm.cmd run dev` (your configured persistent database).
2. Sign in as an administrator and open **Settings → Automatic doubles ranking**.
3. Check **Enable automatic ranking** and save. Defaults are K=32, a minimum of 10 rated matches, and a 20-point hysteresis buffer.
4. Create/edit an event and check **Rated doubles matches**. This marks newly generated matches and updates the flag on existing unplayed matches. Completed results remain unchanged.
5. Finalize scores normally in the event's **Matches** tab. Each participant receives an adjustment and a history entry in the same transaction as the result.

For an existing finalized result, use **Include in Elo** and supply a reason. For a practice result, use **Exclude from Elo**. Existing and legacy results are not automatically backfilled when the engine is enabled. A result finalized while the engine was disabled retains its rated designation but shows **Rating not applied**; explicitly include it after enabling the engine to process it.

The player overview displays the current numerical rating, skill category, confirmation status, count of rated matches, a Chart.js progression chart, and paginated adjustment history. Administrator player management provides **Manage rating** for documented overrides and their release. The leaderboard includes current doubles Elo and can be ordered by rating in Settings. Period/type filters still apply to match statistics; the Elo column is always the player's current full-pool rating.

## Algorithm

Initial ratings are seeded from the pre-existing category:

```text
initial rating = 100 + 200 × (skill category − 1)
team A rating = (rating A1 + rating A2) / 2
team B rating = (rating B1 + rating B2) / 2
expected A = 1 / (1 + 10^((team B rating − team A rating) / 400))
adjustment for each A player = K × (actual A − expected A)
adjustment for each B player = −adjustment for each A player
```

`actual A` is 1 for an A win and 0 for a B win. There are no draws, score-margin multipliers, per-game adjustments within a best-of-three match, or artificial rating floors. Each complete match produces one equal adjustment for both partners, conserving the total rating across its four participants. Ratings are stored without display rounding; the UI shows one decimal place.

Default category boundaries are 200, 400, 600, …, 2200, corresponding to the existing 12 labels. A level-1 player promotes only at **220 or above**; a level-2 player demotes only **below 180**. All other boundaries work the same way. Separate promotion and demotion boundary arrays and the buffer are configurable. Promotion and demotion arrays must each have exactly 11 strictly increasing values, and a demotion boundary cannot exceed its corresponding promotion boundary.

Before 10 rated matches, automatic status remains provisional and the engine does not replace an administrator-confirmed official category. At the configured minimum, the category is confirmed using the buffered thresholds. Confirmation does not guarantee promotion: ten wins against the same increasingly lower-rated opponents produce diminishing gains, and a player may reach the next category later. Categories are bounded to 1–12; numerical ratings remain continuous.

Balanced team generation minimizes numerical team-strength differences, with a penalty for repeated partners. Same-rank mode still prioritizes category proximity. Numeric ratings and combined Elo are displayed alongside the categories. Match generation refreshes team strengths from current player ratings instead of relying on an old draft's values.

## Corrections, invalidation, and manual decisions

Every first eligible finalization captures its K-factor, minimum-match requirement, thresholds, and buffer on the match. Configuration changes apply to subsequently rated matches. Disabling the engine stops new automatic adjustments while preserving history. Correcting or excluding a previously rated match still recalculates its downstream effects even when the engine is disabled.

Rating-affecting transactions write a shared settings revision before changing results or ratings. This serializes competing operations across different events. The engine rebuilds the doubles timeline from immutable player baselines, eligible finalized results, and manual decisions, ordered by effective timestamp and ObjectId for ties. A correction preserves the original completion timestamp. An invalidated result is removed from the timeline; if played/finalized again later, it receives a new completion timestamp. Ledger entries also retain a replay sequence for stable ordering when timestamps tie.

Both teams' average ratings are recalculated at each chronological step, so changes propagate to later partners and opponents. The authoritative result, bracket updates, history rows, cached user ratings, category changes, and notifications commit atomically. History has unique per-player/per-match indexes and stable IDs; duplicate score submissions return the current result without applying Elo twice.

**Invalidate result** clears the score and winner. When necessary, the administrator confirms that downstream bracket results are also cleared. Their rating entries are removed in the same replay. The previous bracket/result state and the reason remain in the audit log.

A manual override creates a dated decision containing the administrator, reason, category, and numerical rating. If no numerical rating is supplied, the chosen category's default midpoint is used. The category stays locked until explicitly released, while numerical Elo continues to respond to rated matches. Replaying older results reapplies that decision at its original timestamp instead of erasing it. Releasing the override resumes category calculation; the 10-match automatic confirmation requirement still applies. Manual decisions do not reset the rated-match count.

Promotions, demotions, and first automatic confirmation produce stored player notifications. Replaying an unchanged timeline does not resend them. A correction can produce a new notification when it changes the player's current category.

Full replay favors correctness for this club-scale application. It scans all rated doubles results and updates derived profiles/history inside a transaction. For very large histories, checkpointed replay or a dedicated ordered worker should replace full replay while preserving the same locking, ordering, and policy-snapshot guarantees. This change does not add multi-instance Socket.IO or distributed rate-limit support.

## Migration

`src/migrations/001-doubles-ratings.js` runs automatically before the server begins listening. It is versioned in the `Migration` collection and is safe to run repeatedly. It preserves users, results, official categories, registrations, and existing audit history. It backfills rating baselines/cache fields and team numerical strengths, adds default disabled settings when absent, and leaves legacy matches unrated. New schemas create the required profile/history indexes during database connection.

For a persistent database, migration can also be invoked explicitly:

```powershell
npm.cmd run migrate
```

The command requires the same `.env` database configuration as `npm start` and a MongoDB replica set/Atlas connection. Preview initializes its own temporary replica set and migrates it automatically. Do not run development seed commands against live club records.

## API

All routes require authentication; administrator routes and match mutations also require the administrator role. JSON mutations require `X-PMS-Request: 1`.

| Route                                                      | Behavior                                                                                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/players/me/rating?pool=doubles&page=1&limit=100` | Current profile, current policy, and the caller's rating history. Limit is 1–200; response includes `total` and `hasMore`.                                      |
| `GET /api/players/me/rating-history`                       | Same paginated response.                                                                                                                                        |
| `GET /api/admin/ratings/settings`                          | Current doubles policy.                                                                                                                                         |
| `PUT /api/admin/ratings/settings`                          | Full policy: `enabled`, `kFactor`, `minimumRatedMatches`, `hysteresis`, `promotionThresholds`, `demotionThresholds`.                                            |
| `POST /api/admin/ratings/recalculate`                      | `{ "reason": "…" }`; deterministic replay without opting legacy matches in.                                                                                     |
| `PUT /api/admin/players/:id/rating-override`               | `{ "action": "manual", "ranking": 5, "rating": 900, "reason": "…" }`; `rating` is optional. Use `action: "release"` with a reason to release the category lock. |
| `PUT /api/admin/players/:id/ranking`                       | Existing endpoint now records a manual override and its reason.                                                                                                 |
| `PUT /api/matches/:id/rating`                              | `{ "rated": true, "revision": 1, "reason": "…" }`; opt in/out and replay affected ratings.                                                                      |
| `POST/PUT /api/matches/:id/results`                        | Existing score payload; optional `rated` selects rating eligibility. Corrections retain chronological position.                                                 |
| `DELETE /api/matches/:id/results`                          | `{ "revision": 1, "reason": "…", "cascadeCorrection": true }`; invalidates the result and recalculates.                                                         |
| `PUT /api/admin/settings`                                  | Existing leaderboard configuration also accepts `leaderboardOrder: "rating"`.                                                                                   |

Supported settings ranges are K=1–128, minimum rated matches=10–1000, buffer=0–100, and boundary values=0–10000. Rank overrides require a reason of 3–500 characters. Player profile updates cannot alter numerical ratings, rated counts, official categories, or manual-override state.

## Tests

```powershell
npm.cmd test
```

`test/ratings.test.js` covers the doubles formula, zero-sum/equal-partner updates, boundaries and hysteresis, ten-match gate, chronological propagation, override anchors, historical policies, and numerical team balancing.

`test/ratings.integration.test.js` uses a separate real MongoDB replica set for concurrent submissions across events, idempotent ledgers, disabled/unrated results, retrospective eligibility, promotions/demotions, cross-event corrections/invalidation, bracket cascades, manual decisions, ownership/role checks, migration idempotence, leaderboard ordering, and DOM components backed by actual APIs. It also boots the main player dashboard and verifies the data passed into Chart.js. DOM checks do not replace a desktop/mobile visual review.
