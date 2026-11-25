/**
 * What a setting definition must look like as a `contributes.configuration`
 * property in package.json. Shared by the manifest tests (unit and
 * integration), which assert the manifest equals it, and by whoever regenerates
 * the manifest after editing `config/settings.ts`.
 */
import type { SettingDef } from '../../../src/extension-backend/config/settings';

export type ManifestProperty = Record<string, unknown>;

export function manifestProperty(def: SettingDef<unknown>): ManifestProperty {
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

interface ConfigurationBlock {
  properties?: Record<string, ManifestProperty>;
}

/**
 * Every property contributed under `contributes.configuration`, which is one
 * block or an array of blocks (VS Code accepts both), merged into one record.
 */
export function manifestProperties(configuration: ConfigurationBlock | ConfigurationBlock[] | undefined): Record<string, ManifestProperty> {
  const blocks = Array.isArray(configuration) ? configuration : configuration ? [configuration] : [];
  return Object.assign({}, ...blocks.map((b) => b.properties ?? {})) as Record<string, ManifestProperty>;
}
