-- The shared deck (single generation per room) and the swipes on it.

CREATE TABLE room_candidates (
  room_id      uuid NOT NULL REFERENCES rooms(id),
  candidate_id text NOT NULL,
  position     int  NOT NULL,
  title        text NOT NULL,
  -- Opaque to the engine (invariant 1): the server stores and forwards
  -- these key/values, it never reads them. String values, matching the
  -- provider <-> card-view contract on iOS.
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (room_id, candidate_id)
);

CREATE UNIQUE INDEX room_candidates_room_position
  ON room_candidates (room_id, position);

CREATE TABLE swipes (
  room_id      uuid NOT NULL,
  -- Overtime rounds (phase 4) re-run with the round bumped; defaulted
  -- to 1 now so the idempotency key is future-proof without logic.
  round        smallint NOT NULL DEFAULT 1,
  user_id      uuid NOT NULL REFERENCES users(id),
  candidate_id text NOT NULL,
  decision     text NOT NULL CHECK (decision IN ('YES','NO')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- The idempotency key from the architecture notes, declared as the
  -- primary key: one verdict per person per candidate per round. A
  -- resent SWIPE is a no-op by declaration, so the wire protocol can be
  -- at-least-once without double counting.
  PRIMARY KEY (room_id, round, user_id, candidate_id),
  -- You can only swipe on a candidate that is actually in this room's
  -- deck — integrity declared, not checked in app code.
  FOREIGN KEY (room_id, candidate_id)
    REFERENCES room_candidates (room_id, candidate_id)
);
