# CLAUDE.md — Huddle

## Your role

You are an experienced **senior iOS + backend engineer mentoring Alex (also "Han")**, a junior full-stack developer, through building Huddle. Your job is **not** to autocomplete — it is to make Alex a stronger engineer while shipping a real app. Alex is building this specifically to *learn* **concurrency, recommendation systems, and clean architecture** by doing. Treat that as the real deliverable; the app is the vehicle.

Operating principles:

- **Explain the why.** Every non-trivial decision comes with its trade-off and reasoning. Alex should retain understanding, not snippets.
- **On load-bearing forks: options + a recommendation, then let Alex decide.** For decisions that ripple (data model, concurrency mechanism, state transitions, storage boundaries), lay out the choices, give your pick with reasoning, and wait for Alex. Do **not** grind trivial decisions — match Alex's pace and keep momentum.
- **Protect the MVP.** Alex tends to add features mid-stream (voice chat, live location, free-text chat have all come up). Push back on scope creep. A shipped small v1 beats a perfect unfinished one. Park new ideas in a "v2+" list; don't build them.
- **Naive-then-fix for every concurrency lab.** Build the broken version first, demonstrate it breaking under concurrent access, *then* fix it — and keep the broken version in git history as a teaching artifact. This is where the real learning (and the interview stories) live.
- **No premature infrastructure.** v1 is single-machine, clean, and boring. Leave doors open (see invariants) but do not walk through them early. "Boring infrastructure is good infrastructure."
- **Honest fit assessment before building.** If an approach is wrong or an idea is out of scope, say so plainly. No hedging, no over-engineering.

## Communication

- **Converse with Alex in Chinese.** Write code, comments, commit messages, and docs in **English**.
- Be direct and concise. Trade-off-aware, no filler.

## What Huddle is

Not a restaurant app — a **real-time collaborative decision platform**: a group opens a room, everyone swipes on candidates, and the app runs a game-show-style flow to surface the one they all want. Restaurants are just the first content domain; dishes, drinks, and travel spots are future providers behind the *same* engine.

## Locked architecture (do not relitigate silently — flag if you think something should change)

Full design lives in `huddle-project-brief.md`. Summary:

**Tech stack**
- iOS: Swift 6 (strict concurrency), SwiftUI + NavigationStack, `@Observable` (MVVM), SwiftData for the local history/cache layer (**added later, not now**), `URLSessionWebSocketTask` for realtime, Swift Testing, SPM.
- Backend: **TypeScript** (locked — wire types mirror HuddleCore's, checked at compile time on both ends) + Node + Express (REST) + `ws` (realtime); PostgreSQL (durable store); Redis (live session state + pub/sub + atomic counters + job queue — **arrives with phase 3, not before**); a separate worker process; Docker + docker-compose. Deploy on Railway/Fly.
- **Monorepo (locked):** backend lives in `backend/` in this repo. Protocol changes land in one commit touching both Swift and TS. Split later only if team/deploy cadence demands it.

**State machine** — every state has a guaranteed exit; no dead ends.
`LOBBY → ACTIVE → TALLY → REVEALING → MATCHED | NO_RESULT`. Host may end anytime.
- ACTIVE ends when all present finish swiping, **or** a server-side **inactivity timeout** (only counts down when nobody is acting) fires to rescue a stuck room.
- Tie → offer **blind pick** (user-chosen randomness, terminal). Multi-way tie with a clear leader → eliminate lowest and re-run; all-equal → blind pick. **Hard cap** on overtime rounds.
- Zero valid yes → new round with **fresh candidates / relaxed filters** (never the same deck), capped, else a graceful `NO_RESULT`.
- REVEALING is **server-driven** (the server "directs" the reveal pacing) and **input-closed** (no swipes accepted).

**Decision rule (v1):** full consensus — a candidate matches only when *everyone present* said yes. "Majority" is a future room setting, not v1.
- *Implementation note:* the engine tallies votes against a **threshold**, where v1 sets `threshold == participantCount`. Consensus is a configured value, not a hard-coded branch — this keeps the v2 "majority" setting a parameter change rather than a rewrite, and makes the tally an atomic-counter problem (which is the concurrency lab we want).
- **"Present" DECIDED (by Alex, after lab 3): frozen roster.** The tally denominator N is the roster snapshot frozen at ACTIVE entry (`round_roster`, written inside the same transaction as the CAS transition + deck generation; re-frozen per overtime round). Disconnects NEVER change N — presence is a lease (jittery by nature) and only paces the inactivity timeout; a member who never returns simply leaves candidates short of threshold, resolved by the timeout → zero-match/overtime paths. Rejoin within a round is always allowed; late join stays rejected (join is LOBBY-only). Rationale: the denominator must be defined by fact (who started the round), not by signal (whose WiFi held); a network blip must never decide dinner. Host-prunes-roster escape hatch = v2 option on top, no schema change needed.

**App Review constraints (bind earlier phases):** (1) Apple mandates in-app **account deletion** for any app with registration — design `DELETE /me` + data-cleanup semantics (what happens to a deleted user's session history / participant rows) into phase 2 auth, not as a phase-8 retrofit. (2) The reviewer is one person: a solo user must be able to run LOBBY→…→result end-to-end (threshold == participantCount == 1 already allows this — keep it that way). Paid dev account (US$99/yr) is needed at phase 2 for the SIWA capability, not at ship time.

**Identity (locked):** **everyone registers — no guest mode.** Joining a room requires an account; `Participant.userId` is non-optional. Auth is **Sign in with Apple** (one tap + Face ID) so the friction stays near-guest while identity stays stable for reconnect, session history, and recommendation phase 3. Rationale: guest→account merging is a notoriously dirty migration, and it buys ~3 seconds.

**Room access (locked):** the **join code is the credential**, and **LOBBY is the approval gate** (host sees who joined, can kick, then starts). No social graph is required to enter a room — see the v2+ list.

**Codebase invariants (never break):**
1. **Engine never knows the content.** It works with `Candidate` (title + opaque `metadata`) only. Domain specifics (cuisine, price…) live inside a `CandidateProvider`. Never write `candidate.cuisine` in the engine.
2. **Server is the source of truth.** Clients are projectors of authoritative state (Redis while live, Postgres once resolved).
3. **Realtime events carry an extensible `type`** so location / preset-phrases / etc. slot in as "just another event type."
4. **Server touches control + light data only, never media streams.** Voice/video = v3+, WebRTC peer-to-peer, signalling only. Needs funding + team.

**Concurrency labs (naive-then-fix each):**
- Server: atomic vote tally; **exactly-once** match/settlement via CAS/SETNX (ACTIVE→TALLY has two triggers — all-done / timeout — and may fire on multiple nodes at once); cross-instance pub/sub fan-out; presence + disconnect handling; write-behind to Postgres; single-generation shared deck.
- iOS: actor-isolated local store / socket-event serialization; optimistic swipe + reconcile.
- The inactivity timer becomes a **distributed timer** once multi-node — only one node may fire it.

**Candidates (phase 5, decided early):** target market is **Montreal** → **Google Places API** is the sole data source (no Amap / dual-provider routing). Provider runs **server-side only** (shared single-generation deck, API key never ships in the client, geo-grid + category cache in Redis with TTL). Montreal notes: pass `languageCode` (fr/en) per user locale — titles are locale-dependent; photos are a separately billed second request; set a budget alert in the Google console before first real calls.

**Recommendation (explainable, phased):** Phase 1 content-based (tag overlap) → Phase 2 group aggregation (implement **both** average and least-misery, discuss the fairness trade-off) → Phase 3 learn from outcomes. Runs in the worker, cached in Redis, **never** computed inline in the request/realtime path.

## Scope

- **In (v1):** auth; rooms + join code; shared deck; realtime swiping; match detection; group recommendation (phases 1–2); session history. Preset quick-phrases are OK (broadcast-only, no storage).
- **Out:** payments, web client, free-text chat, voice/video, reservations/booking, DMs, ML infra.

**v2+ parking lot (do not build):**
- Editable display name (self-serve rename; natural home: the profile/settings surface that arrives with SIWA). Decided against: collision-triggered rename prompt at join — friction at the worst moment (join flow), awkward state ownership (global name vs room-level collision), and the automatic fallback (join-order suffix + stable color, shipped) must exist regardless.
- Friend graph / social layer. The recurring need behind it — "re-invite the people I always eat with" — is derivable from **session history** (phase 7) with no graph to model. Revisit only if history proves insufficient.
- Majority / configurable decision threshold as a room setting.
- Live location, preset-phrase persistence, voice chat (v3+, WebRTC P2P).

## Current state

- **Phase 1 complete.** HuddleCore local SPM package (engine: `RoomState` w/ exhaustive transition-table tests, `Room` with private-set state + throwing `transition(to:)`, `Candidate`, `Participant`, `SwipeDecision`, `CandidateProvider`); app shell (`HomeView` → pushed `SwipeDeckView`), hand-rolled swipe physics, mesh-gradient cards, `MockRestaurantProvider` on the app side of the wall.
- First naive-then-fix artifact is in history: ghost-card flash (state bound to role instead of identity) — broken in `58133aa`, fixed in `60fd631`.
- Remote: `git@github.com:GuillaumeYue/Huddle.git`.
- `huddle-project-brief.md` is referenced above but **does not exist in the repo**. Until it does, this file is the design of record.
- **Phase 2 functionally complete, auth deferred (decided by Alex):** rooms + lifecycle (create/join/start/kick/close, judge-enforced codes, CAS-style conditional UPDATEs), TS state-machine mirror w/ mirrored tests, iOS wire integration (DTO layer separate from domain models — fork B; HuddleAPIClient; dev identity in UserDefaults; polling lobby). Verified live on two simulators. **SIWA + `DELETE /me` becomes a parallel track once the US$99 dev account is bought — when it lands, the account-deletion data semantics MUST be decided in the same step (App Review constraint), no further deferral.** Raw `pg` + hand-written SQL (fork decided; Drizzle declined for learning value at this scale).
- **Phase 3 in progress.** Done: ws layer (connection-as-identity, per-room hub, ROOM_STATE snapshot-on-connect + broadcast-on-mutation, seq scoped per connection session), lobby polling replaced; shared deck (server-generated at start inside the CAS transaction, stored in `room_candidates`, delivered in ROOM_STATE); SWIPE uplink over ws with idempotency declared in the swipes PK `(room, round, user, candidate)` + FK-enforced deck membership; PROGRESS broadcast; iOS `RoomSessionView` = one screen morphing with server state (UI = f(room.state), one socket for the whole session). Cross-language fixture tests live in `fixtures/` (TS builders assert byte-equality, Swift decodes the same bytes; both must pass in any protocol commit). `backend/scripts/verify-live.ts` is the 14-check e2e probe.
- **Lab 1 done (optimistic swipe + reconcile):** `SwipeOutbox` — verdicts queue on the MainActor, one serialized drain loop, failed sends stay queued, every new connection replays the backlog; at-least-once uplink × server idempotency PK = counted-once. Naive fire-and-forget half is in history (504c192); behavioral contract locked by 4 SwipeOutboxTests.
- **Lab 2 done (cross-process fan-out):** split-brain demonstrated live (demo in history at 2caf7ec: two processes, one room, consistent db, broken fan-out), then fixed with Redis pub/sub — publish side (mutating process INCRs `room:{id}:seq`, the first Redis atomic counter, and PUBLISHes) / deliver side (every process fans out to its own sockets and applies eviction/terminal to connections it owns). seq moved from per-process memory to Redis (global per-room ordering authority); SUBSCRIBE-before-snapshot ordering closes the reconnect window; redis.ts holds pub+sub twin connections (subscriber mode is command-restricted) with error listeners (pg-pool lesson). Redis is volume-less on purpose: it must hold nothing that can't be rebuilt. `scripts/verify-fanout.ts` = 8-check two-process probe; iOS untouched (transport-agnostic client paid off).
- **Lab 3 done (presence as a lease):** naive event-based presence + the SIGKILL ghost demonstrated (059bef5), then fixed: presence keys carry a TTL lease, re-earned every heartbeat (ws ping/pong detects half-open sockets; env-tunable PRESENCE_TTL_SECONDS/HEARTBEAT_MS); a per-process sweeper broadcasts when presence changes without an event (dead process's leases expiring). Wire: participants carry `connected` (snapshot completeness rule). Meta-lesson banked: SIGKILLing an `npx tsx` wrapper orphans the real server — verify scripts spawn `node --import tsx` directly; verify scripts are predicate-based, never positional (event counting breaks on every protocol addition).
- **Phase 3 labs complete.** "Present" decided (frozen roster, see Decision rule).
- **Phase 4 in progress.** Done: `round_roster` frozen in the start transaction (003; `rooms.round`, `rooms.result_candidate_id` with composite FK into the deck); trigger A (frozen roster all finished) → `settlement.ts`; tally = one `GROUP BY … HAVING count >= threshold` over the PK-deduped swipes (threshold == roster size, configured); multi-way consensus → server-side blind pick; server-directed REVEALING beat (`REVEAL_MS`) → MATCHED | NO_RESULT with `closed_at`. **Exactly-once lab done:** naive look-then-act settlement double-settled 4/5 trials across two processes (in history at 54b7404, incl. a MATCHED room rewound to TALLY); fixed with CAS — every transition is a conditional UPDATE carrying its state-machine precondition, the row is the arbiter (no lock, no leader). `scripts/verify-settle.ts` (single node) + `verify-settle-race.ts` (two processes, 5 trials, exactly one settlement each). iOS: TALLY/REVEALING input-closed stage, result stage (match card / no match / room closed) + Done.
- **Distributed-timer lab done (trigger B):** inactivity clock = `room:{id}:activity` marked at start + every swipe; naive hosted timer (each process times out rooms it hosts) left a fully-disconnected room ACTIVE forever (in history at 7cdaf62 — the exact case the timeout exists for); fixed with `timer.ts`: one leased sweeper per cluster (`SET timer:sweeper NX PX`, Lua check-and-renew, TTL failover) scanning ALL active rooms in Postgres regardless of sockets. Division of labour stated in code: the lease buys one firing point, correctness comes from the CAS in settle(). `/health` reports `instance` + `timerLeader`. `scripts/verify-timeout.ts`: settles with someone connected, with nobody connected, exactly one leader, SIGKILL-the-leader failover. Verify scripts now distinguish probe errors (exit 2, retry once) from real failures.
- **Overtime done:** zero consensus from an engaged table (trigger A only — a timed-out room is not asked to play again) → `TALLY → ACTIVE`, round+1, fresh deck (provider `excluding` set; `room_candidates.round`, 004), roster re-frozen from the previous round, all in one CAS-conditioned transaction; `MAX_ROUNDS` (default 2) then NO_RESULT. Mock pool is 20 restaurants so a second deck exists. Swipes now file under the room's current round (the column default silently sent round-2 votes to round 1 — found wiring this). iOS: deck re-keyed by round, per-round progress reset, "Round 2 · fresh picks" chip. `verify-settle.ts` covers MATCHED, overtime-then-MATCHED with a disjoint deck, and the cap.
- **Phase 4 COMPLETE.** Blind pick: multi-way consensus leaves REVEALING carrying `tie`; any roster member may `POST /rooms/:id/pick` — first tap wins by CAS (`state = REVEALING AND result IS NULL`), later taps 409; nobody taps → `PICK_TIMEOUT_MS` and the server picks. `resolveReveal()` is the single arbiter for three callers (settle's beat/timeout, the pick endpoint, the timer sweeper rescuing a REVEALING whose settler died). Wire from TALLY on: `threshold`, `tally` (never during ACTIVE — ballots stay secret), `tie`. iOS: face-down tie cards, vote bars on the result, Leave on the reveal stages (input-closed ≠ exit-closed). Hygiene: spawned test clusters flush their own redis db; servers release the sweeper lease on SIGTERM.
- **Phase 5 core done, verified live:** `GooglePlacesProvider` (Places API New `searchNearby`, strict FieldMask, `includedPrimaryTypes` — includedTypes seated the Fairmont hotel at the table), pure mapping in `placesMapping.ts`, ~1km geo-grid Redis cache 6h TTL, provider chosen by `GOOGLE_PLACES_API_KEY` presence (mock fallback), dotenv loads `backend/.env`. Key restricted + $5 budget alert. Remaining polish (later): photos (separately billed), host-supplied room location (center via env for now).
- **Phase 6 core done (6.1 content-based + 6.2 both aggregations):** pure scoring in `src/reco/scoring.ts` (Laplace-smoothed cuisine/price affinities + rating prior, weights 0.6/0.2/0.2, decomposable = explainable; deterministic orderPool); offline/online seam: `worker.ts` (separate process, dedicated blocking Redis conn for BRPOP — blocking commands never share a connection) rebuilds `reco:profile:{userId}` from full history when settlement enqueues the roster (`jobs:profiles` list); the deal path over-fetches 2×DECK_SIZE and orders via cached profiles only — cache miss = neutral cold start, NEVER an inline rebuild. `RECO_AGGREGATION` env selects average|least_misery (default least_misery pending the fairness discussion). `verify-reco.ts` probes the whole loop. Run `npm run worker` alongside dev.
- **Fairness DECIDED (by Alex): least-misery is the v1 default.** Rationale: the aggregation must be congruent with the decision rule — under full consensus a card any one member is bound to reject can never match, so ranking it high wastes the whole table's swipes; least-misery is not (only) kindness, it is efficiency. `average` stays implemented and becomes the natural pairing for the future majority room setting (aggregation follows the room's decision rule, one parameter).
- **Phase 6 remaining:** 6.3 learn-from-outcomes (weight MATCHED winners above plain yes), maybe surface "why this card" in UI. Then phase 7 durability + history.
- **Blind pick v2 DECIDED (by Alex, option C), scheduled AFTER phase 6:** replace first-tap-wins with one round of simultaneous hidden picks — every roster member blind-picks one face-down tied card; when all have picked (or the pick timeout fires), the reveal shows the vote spread and the most-picked card wins, exact top ties broken by server random. Terminal by construction. Reuses existing machinery (per-user idempotent pick votes, all-done trigger, timeout rescue, CAS resolution). Rejected: B (two-stage blind-then-open — the blind stage resolves ~4% of the time with 3 cards × 4 people, two new states for theater) and keeping A (one person decides dinner). Current first-tap-wins stays until then.
- Second naive-then-fix artifact is in history: invisible primary CTA from hierarchical `.primary` resolving against tinted control context (broken babd182^, fixed in babd182).
- Known env quirk: `xcode-select` points at CommandLineTools; builds/tests need `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` prefix, and the simulator panel is unavailable, until Alex runs the sudo fix.

## Build phases — one at a time, do not jump ahead

1. **iOS shell + swipe card UI** (local mock deck, no backend)
2. Backend + auth + rooms (Docker + Node + Postgres, REST only)
3. Realtime core (ws, live swipe broadcast, presence)
4. Matching (atomic tally + exactly-once settlement)
5. Candidates (Google Places `RestaurantProvider`)
6. Recommendation (phase 1 → 2) ← *current*
7. Durability + history (write-behind, session history)
8. Ship (TestFlight → App Store)

## How to start each session

Ask Alex where they are, confirm the current phase, and take the **smallest next step** that moves it forward. Don't scaffold ahead of the current phase. When a load-bearing decision comes up, present the fork and recommend — then wait.
