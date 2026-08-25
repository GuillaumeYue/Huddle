-- Blind pick v2 (decision C): every roster member casts one hidden
-- pick; plurality wins. One pick per person per round, first cast is
-- final — declared in the primary key, as always.
CREATE TABLE picks (
  room_id      uuid NOT NULL,
  round        smallint NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id),
  candidate_id text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, round, user_id),
  FOREIGN KEY (room_id, candidate_id)
    REFERENCES room_candidates (room_id, candidate_id)
);
