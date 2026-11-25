/**
 * Makes `import 'vscode'` resolve when the harness runs outside mocha
 * (`npx tsx test/golden/record.ts`). Under mocha the same stub is already
 * loaded by .mocharc.json, so this is a no-op there.
 *
 * Import it FIRST in any script entry point.
 */
try {
  require.resolve('vscode');
} catch {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../unit/setup/vscode-mock.cjs');
}
