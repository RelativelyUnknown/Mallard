/**
 * Guards for the security-relevant parts of package.json that no other test
 * reads: setting scopes and the workspace-trust capabilities. (The settings
 * themselves are checked against the table in settingsManifest.test.ts.)
 */
import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';

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
  };
}
const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../../package.json'), 'utf8')) as Manifest;

describe('package.json — setting scopes', () => {
  const props = pkg.contributes.configuration.properties;

  it('export, server, certificate and pricing-URL settings cannot be set by a workspace', () => {
    for (const key of [
      'mallard.server.url',
      'mallard.export.transport',
      'mallard.webhook.auth',
      'mallard.export.webhookTargets',
      'mallard.export.mqttTargets',
      'mallard.mqtt.url',
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
    // The only workspace-overridable setting; githubBilling.org is application-scoped now, so a workspace cannot set it at all.
    assert.deepEqual(t.restrictedConfigurations, ['mallard.copilotOtelPath']);
  });

  it('declares its virtual-workspace limits instead of leaving them implicit', () => {
    assert.equal(pkg.capabilities.virtualWorkspaces.supported, 'limited');
    assert.ok((pkg.capabilities.virtualWorkspaces.description ?? '').length > 20);
  });
});

describe('package.json — description', () => {
  it('does not claim "No sign-in" outright (GitHub billing sign-in is optional, not absent)', () => {
    assert.ok(!/No sign-in,/.test(pkg.description), pkg.description);
    assert.match(pkg.description, /no sign-in required, no telemetry/i);
  });
});
