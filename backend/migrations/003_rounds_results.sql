-- Phase 4: the frozen roster (decision B) and settlement results.

-- Current round; bumped by overtime rounds (later). Swipes and the
-- roster are both keyed by it.
ALTER TABLE rooms ADD COLUMN round smallint NOT NULL DEFAULT 1;

-- The settled outcome. Composite FK: the winner MUST be a candidate of
-- this very room's deck — integrity declared, not checked in app code.
ALTER TABLE rooms ADD COLUMN result_candidate_id text;
ALTER TABLE rooms
  ADD CONSTRAINT rooms_result_in_deck
  FOREIGN KEY (id, result_candidate_id)
  REFERENCES room_candidates (room_id, candidate_id);

-- "Present" = this table. Frozen inside the start transaction (and
-- re-frozen per overtime round): the tally denominator is defined by
-- FACT (who started the round), never by presence SIGNAL. A network
-- blip must never decide dinner.
CREATE TABLE round_roster (
  room_id uuid NOT NULL REFERENCES rooms(id),
  round   smallint NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (room_id, round, user_id)
);
