import { type LocalDate } from '@ftms/core';

export interface ExistingOccurrence {
  id: string;
  occurrenceDate: LocalDate;
  /** Changed individually: the schedule no longer manages it (§6.1). */
  detached: boolean;
  /** Check-in has opened or the visit is over: it is history and stays as it is. */
  locked: boolean;
}

export interface OccurrencePlan {
  /** Dates that need a new session. */
  create: LocalDate[];
  /** Sessions that follow the new definition (updated in place). */
  keep: string[];
  /** Sessions the new definition no longer has. */
  remove: string[];
}

/**
 * Reconciles a schedule's sessions with its (new) definition. `wanted` are the
 * upcoming dates the definition yields. Sessions that were changed on their own
 * or have started are never touched; a date that already has any session —
 * even one moved elsewhere or cancelled — gets no second one.
 */
export function planOccurrences(
  wanted: readonly LocalDate[],
  existing: readonly ExistingOccurrence[],
): OccurrencePlan {
  const wantedSet = new Set(wanted);
  const taken = new Set(existing.map((e) => e.occurrenceDate));
  const keep: string[] = [];
  const remove: string[] = [];
  for (const occurrence of existing) {
    if (occurrence.detached || occurrence.locked) continue;
    (wantedSet.has(occurrence.occurrenceDate) ? keep : remove).push(occurrence.id);
  }
  return { create: wanted.filter((d) => !taken.has(d)), keep, remove };
}
