/**
 * What a setting definition must look like as a `contributes.configuration`
 * property in package.json. Shared by the manifest test (which asserts the
 * manifest equals it) and by whoever regenerates the manifest after editing
 * `config/settings.ts`.
 */
import type { SettingDef } from '../../../src/extension-backend/config/settings';

export function manifestProperty(def: SettingDef<unknown>): Record<string, unknown> {
  return {
    type: def.type,
    ...(def.enum ? { enum: [...def.enum] } : {}),
    ...(def.enumDescriptions ? { enumDescriptions: [...def.enumDescriptions] } : {}),
    default: def.default,
    ...(def.minimum !== undefined ? { minimum: def.minimum } : {}),
    ...(def.maximum !== undefined ? { maximum: def.maximum } : {}),
    ...(def.pattern !== undefined ? { pattern: def.pattern } : {}),
    ...(def.items ? { items: def.items } : {}),
    ...(def.additionalProperties ? { additionalProperties: def.additionalProperties } : {}),
    scope: def.scope,
    description: def.description,
  };
}
