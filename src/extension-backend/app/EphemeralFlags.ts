/**
 * Machine-local, one-shot UX flags: onboarding completion, "don't show again"
 * dismissals, per-connector setup nudges. These deliberately live in
 * globalState rather than settings — they carry no user intent worth
 * hand-editing or carrying between machines. Every other user-facing knob
 * lives in VS Code settings. Keeping the keys in one module
 * means "Prepare for Uninstall" (which clears all globalState keys) is the
 * only other place that needs to know they exist.
 */
import * as vscode from 'vscode';

export const FLAG_ONBOARDING_COMPLETED = 'mallard.onboardingCompleted';
export const FLAG_REMOTE_COPILOT_WARNED = 'mallard.remoteCopilotWarned';
/** The "config.json could not be imported" warning was shown (once; it would repeat on every start). */
export const FLAG_CONFIG_IMPORT_WARNED = 'mallard.configImportWarned';

/** One flag per connector SetupRequirement — "this nudge was shown once". */
export function setupNudgeFlag(requirementId: string): string {
  return `mallard.setupNudge.${requirementId}`;
}

export function getFlag(state: vscode.Memento, key: string): boolean {
  return state.get<boolean>(key) === true;
}

export async function setFlag(state: vscode.Memento, key: string): Promise<void> {
  await state.update(key, true);
}
