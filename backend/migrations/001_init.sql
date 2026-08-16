-- Users, rooms, membership. Auth (Sign in with Apple) lands later in
-- phase 2; until then users are created via a dev-only endpoint and
-- apple_sub stays NULL. DELETE /me cleanup semantics are deliberately
-- not decided here — plain FKs for now, revisited with auth.

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apple_sub    text UNIQUE,
  display_name text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rooms (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  join_code  text NOT NULL,
  host_id    uuid NOT NULL REFERENCES users(id),
  -- Durable copy of the room lifecycle; the live copy moves to Redis in
  -- phase 3 (invariant 2: Redis while live, Postgres once resolved).
  -- Values mirror HuddleCore's RoomState wire strings exactly.
  state      text NOT NULL DEFAULT 'LOBBY'
    CHECK (state IN ('LOBBY','ACTIVE','TALLY','REVEALING','MATCHED','NO_RESULT')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at  timestamptz
);

-- The judge for join-code collisions: uniqueness is declared, not checked
-- in app code (check-then-insert is a read-modify-write race). Partial:
-- only LIVE rooms hold their code, so codes recycle automatically when a
-- room closes — no cleanup job, and the code space never exhausts.
CREATE UNIQUE INDEX rooms_live_join_code
  ON rooms (join_code) WHERE closed_at IS NULL;

CREATE TABLE room_participants (
  room_id   uuid NOT NULL REFERENCES rooms(id),
  user_id   uuid NOT NULL REFERENCES users(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  -- One row per person per room: a duplicate join is a no-op by
  -- declaration (ON CONFLICT DO NOTHING), which makes the join endpoint
  -- naturally idempotent — retries and double-taps cost nothing.
  PRIMARY KEY (room_id, user_id)
);
