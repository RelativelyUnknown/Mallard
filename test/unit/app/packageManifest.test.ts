/**
 * Guards for the security-relevant parts of package.json that no other test
 * reads: setting scopes, workspace-trust capabilities and the config.json
 * schema association.
 */
import { strict as assert } from 'assert';
import { promises as fs, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UserConfigStore } from '../../../src/extension-backend/app/UserConfigStore';

interface Manifest {
  description: string;
  publisher: string;
  name: string;
  capabilities: {
    untrustedWorkspaces: { supported: string; description: string; restrictedConfigurations?: string[] };
    virtualWorkspaces: { supported: string | boolean; description?: string };
  };
  contributes: {
    configuration: { properties: Record<string, { scope?: string }> };
    jsonValidation: Array<{ fileMatch: string | string[]; url: string }>;
  };
}
const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../../package.json'), 'utf8')) as Manifest;

// Matches the only glob form the manifest uses: a leading `**/` followed by a literal path suffix.
function matchesGlob(glob: string, file: string): boolean {
  assert.ok(glob.startsWith('**/') && !glob.includes('*', 3), `unsupported glob in manifest: ${glob}`);
  return file.endsWith(`/${glob.slice(3)}`);
}

describe('package.json — setting scopes', () => {
  const props = pkg.contributes.configuration.properties;

  it('export, server, certificate and pricing-URL settings cannot be set by a workspace', () => {
    for (const key of [
      'mallard.server.url',
      'mallard.export.transport',
      'mallard.webhook.auth',
      'mallard.mqtt.url',
      'mallard.mqtt.auth',
      'mallard.mqtt.username',
      'mallard.shared.certificate.file',
      'mallard.shared.certificate.keyFile',
      'mallard.shared.certificate.caFile',
      'mallard.pricingManifestUrl',
    ]) {
      assert.equal(props[key]?.scope, 'machine', `${key} must be machine-scoped (not machine-overridable)`);
    }
  });

  it('no setting that carries a destination or credential path is workspace-overridable', () => {
    for (const [key, def] of Object.entries(props)) {
      if (/url$|certificate|transport|auth$/i.test(key)) {
        assert.ok(def.scope === 'machine' || def.scope === 'application', `${key}: ${def.scope}`);
      }
    }
  });
});

describe('package.json — workspace trust', () => {
  it('declares limited untrusted-workspace support and lists the restricted settings', () => {
    const t = pkg.capabilities.untrustedWorkspaces;
    assert.equal(t.supported, 'limited');
    assert.ok(t.description.length > 20);
    for (const key of ['mallard.copilotLogPath', 'mallard.copilotOtelPath', 'mallard.githubBilling.org']) {
      assert.ok(t.restrictedConfigurations?.includes(key), key);
    }
  });

  it('declares its virtual-workspace limits instead of leaving them implicit', () => {
    assert.equal(pkg.capabilities.virtualWorkspaces.supported, 'limited');
    assert.ok((pkg.capabilities.virtualWorkspaces.description ?? '').length > 20);
  });
});

describe('package.json — config.json schema association', () => {
  it('fileMatch matches where UserConfigStore really writes config.json', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-manifest-'));
    // <globalStorage>/<publisher>.<name>/config.json
    const storage = path.join(root, 'globalStorage', `${pkg.publisher}.${pkg.name}`);
    const store = new UserConfigStore(storage);
    const file = store.uri.fsPath.replace(/\\/g, '/');
    store.dispose();
    const patterns = pkg.contributes.jsonValidation.flatMap((v) =>
      Array.isArray(v.fileMatch) ? v.fileMatch : [v.fileMatch],
    );
    assert.ok(
      patterns.some((p) => matchesGlob(p, file)),
      `none of ${patterns.join(', ')} matches ${file}`,
    );
    assert.ok(
      !patterns.some((p) => matchesGlob(p, '/home/u/project/mallard/config.json')),
      'must not capture an unrelated project file',
    );
  });
});

describe('package.json — description', () => {
  it('does not claim "No sign-in" outright (GitHub billing sign-in is optional, not absent)', () => {
    assert.ok(!/No sign-in,/.test(pkg.description), pkg.description);
    assert.match(pkg.description, /no sign-in required, no telemetry/i);
  });
});
