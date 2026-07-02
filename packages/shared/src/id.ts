import { ulid } from "ulid";

/** All primary-key IDs in this project are ULIDs (lexicographically sortable by creation time). */
export function newId(): string {
  return ulid();
}
