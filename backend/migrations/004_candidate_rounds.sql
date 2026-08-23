-- Overtime rounds deal a fresh deck; candidates are keyed by round.
-- The PK (room_id, candidate_id) stands: a candidate never appears in
-- two rounds of the same room ("never the same deck"), so position
-- uniqueness moves to (room_id, round, position).
ALTER TABLE room_candidates ADD COLUMN round smallint NOT NULL DEFAULT 1;
DROP INDEX room_candidates_room_position;
CREATE UNIQUE INDEX room_candidates_room_round_position
  ON room_candidates (room_id, round, position);
