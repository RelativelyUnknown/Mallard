/**
 * The full wipe behind "Mallard: Prepare for Uninstall". Lives outside
 * extension.ts so the ordering (which matters) can be unit-tested.
 */
import { UserConfig } from '../domain/types';
import { deleteQueueFiles } from '../export/ExportQueue';
import { deleteLegacyConfigFiles } from './ConfigImporter';
import { ALL_SECRET_KEYS, exportTargetSlots } from './credentials';

export interface WipeDeps {
  storageDir: string;
  secrets: { delete(key: string): PromiseLike<void> };
  globalState: { keys(): readonly string[]; update(key: string, value: unknown): PromiseLike<void> };
  store: { clear(): Promise<void> };
  userConfig: { get(): UserConfig; reset(): Promise<void> };
  layout: { reset(): Promise<void> };
  pricing: { clearCache(): Promise<void> };
  restriction: { clearAll(): Promise<void> };
}

export async function wipeAllData(deps: WipeDeps): Promise<void> {
  // The per-target secret keys are derived from the target ids in the
  // `mallard.export.*Targets` settings, so they have to be worked out BEFORE the
  // settings are reset — afterwards the targets are gone and their credentials
  // would be orphaned in the OS keychain for good.
  const targetSecretKeys = exportTargetSlots(deps.userConfig.get().export).map((s) => s.key);

  await deps.store.clear();
  await deps.userConfig.reset();
  await deps.layout.reset();
  await deps.pricing.clearCache();
  await deps.restriction.clearAll();
  for (const key of deps.globalState.keys()) {
    await deps.globalState.update(key, undefined);
  }
  for (const secretKey of [...ALL_SECRET_KEYS, ...targetSecretKeys]) {
    await deps.secrets.delete(secretKey);
  }
  // Undelivered export batches (one queue file per target) hold usage data too.
  deleteQueueFiles(deps.storageDir);
  // A pre-settings config.json, or its `.migrated` backup (which keeps the old
  // alert rules), belongs to the data being wiped.
  deleteLegacyConfigFiles(deps.storageDir);
}
