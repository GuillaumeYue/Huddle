import { randomInt } from "node:crypto";

/**
 * Human-relayable room codes: 6 chars from an alphabet with the
 * look-alikes removed (no 0/O, 1/I/L) — these codes get read aloud
 * across a dinner table and typed on phone keyboards.
 *
 * 31^6 ≈ 890M combinations vs a handful of live rooms: blind guessing is
 * hopeless (that, plus the LOBBY approval gate, is the access-control
 * story). Collisions among live rooms are ~never, but "~never" is not a
 * correctness argument — the unique index is. This generator only needs
 * to be random; the database decides winners.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 6;

export function generateJoinCode(): string {
  let code = "";
  for (let i = 0; i < LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}
