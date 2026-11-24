/**
 * Pure presentation rules for the restriction state, kept out of extension.ts
 * (which cannot be unit-tested) so the popup and status bar agree on what
 * "snoozed" means.
 */
import { RestrictionState } from '../domain/types';

/** True while the user's snooze (override) on an active restriction is running. */
export function isSnoozed(state: RestrictionState, now: number): boolean {
  const until = state.userOverrideUntil;
  return !!until && until > now;
}

export interface PromptDecision {
  /** Open the restriction popup now. */
  show: boolean;
  /** The restriction the user has already been shown, to pass back on the next call. */
  shownKey: string | undefined;
}

/**
 * Decide whether a restriction change should open the popup. It shows once
 * per restriction — on the transition to active, or when the reason changes —
 * and never while snoozed. The shown marker is forgotten while snoozed (and
 * while inactive), so the popup comes back when the snooze ends.
 *
 * The old listener only checked `state.active`, so snoozing (which itself
 * fires a change event with the restriction still active) re-opened the
 * popup immediately.
 */
export function decideRestrictionPrompt(
  state: RestrictionState,
  shownKey: string | undefined,
  now: number,
): PromptDecision {
  if (!state.active || isSnoozed(state, now)) return { show: false, shownKey: undefined };
  const key = `${state.ruleId}\n${state.reasonMessage}`;
  return key === shownKey ? { show: false, shownKey } : { show: true, shownKey: key };
}

export type RestrictionStatus = 'snoozed' | 'limit' | 'none';

/** What the status bar should say about the restriction. A snooze wins over the limit it suspends. */
export function restrictionStatus(state: RestrictionState, now: number): RestrictionStatus {
  if (isSnoozed(state, now)) return 'snoozed';
  return state.active ? 'limit' : 'none';
}
