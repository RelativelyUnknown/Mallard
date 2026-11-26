'use strict';
// S4: can VS Code settings express what the plan needs? Runs INSIDE the extension host
// (needs `vscode`), against the real settings.json files in the test user-data dir / workspace.
const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function readJsonc(file) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    try {
      return JSON.parse(t);
    } catch (_) {
      return JSON.parse(t.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
    }
  } catch (e) {
    return { __error: String(e.message) };
  }
}

async function runSettingsChecks({ vscode, extensionId, userDataDir, workspaceDir, pkgJsonPath, trustLabel }) {
  const results = [];
  const check = async (id, item, fn) => {
    try {
      const r = await fn();
      if (r && r.__status) results.push({ id, item, status: r.__status, pass: r.__status === 'PASS', evidence: r.evidence });
      else results.push({ id, item, status: 'PASS', pass: true, evidence: r === undefined ? null : r });
    } catch (e) {
      results.push({ id, item, status: 'FAIL', pass: false, evidence: `${e && e.message}` });
    }
  };
  const must = (c, m) => {
    if (!c) throw new Error(m);
  };

  const userSettings = path.join(userDataDir, 'User', 'settings.json');
  const wsSettings = path.join(workspaceDir, '.vscode', 'settings.json');
  const cfg = () => vscode.workspace.getConfiguration('spike');
  const G = vscode.ConfigurationTarget.Global;

  // ---- event collector ----
  const events = [];
  const KEYS = [
    'spike',
    'spike.rulesApp',
    'spike.rulesMachine',
    'spike.targets',
    'spike.branchBudgets',
    'spike.monthlyBudget',
    'spike.display.mode',
    'spike.display',
    'spike.rulesResource',
    'spike.rulesWindow',
    'spike.rulesMachineOverridable',
    'spike.rulesLang',
  ];
  vscode.workspace.onDidChangeConfiguration((e) => {
    const affects = {};
    for (const k of KEYS) affects[k] = e.affectsConfiguration(k);
    events.push({ t: Date.now(), affects });
  });
  /** Run `action`, then collect change events for up to `waitMs` (or until `expectKey` fires + 300 ms). */
  async function observe(action, { expectKey, waitMs = 5000 } = {}) {
    await sleep(350); // let late events from the previous step drain
    events.length = 0;
    const t0 = Date.now();
    await action();
    const deadline = t0 + waitMs;
    let firstHit = null;
    while (Date.now() < deadline) {
      if (expectKey && events.some((e) => e.affects[expectKey])) {
        firstHit = firstHit || Date.now();
        if (Date.now() - firstHit > 300) break;
      }
      await sleep(50);
    }
    if (!expectKey) await sleep(Math.min(1200, Math.max(0, deadline - Date.now())));
    const fired = {};
    for (const k of KEYS) fired[k] = events.some((e) => e.affects[k]);
    return { eventCount: events.length, fired, latencyMs: events.length ? events[0].t - t0 : null };
  }
  const writeUser = (obj) => fs.writeFileSync(userSettings, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  fs.mkdirSync(path.dirname(userSettings), { recursive: true });
  if (!fs.existsSync(userSettings)) writeUser({});

  const R1 = { id: 'r1', metric: 'today.credits', op: '>', value: 50, cooldown: 3600, severity: 'warning', notify: true, restrict: false };
  const R2 = { id: 'r2', metric: 'month.cost', op: '>=', value: 100, cooldown: 86400, severity: 'critical', notify: true, restrict: true };

  // ---------- 6. table-vs-manifest ----------
  await check('S4.6', 'package.json contributes.configuration readable at runtime via extensions.getExtension().packageJSON (defaults/ranges/enums)', async () => {
    const ext = vscode.extensions.getExtension(extensionId);
    const manifest = ext.packageJSON.contributes.configuration;
    const onDisk = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).contributes.configuration;
    must(deepEq(manifest, onDisk), 'runtime manifest differs from package.json on disk');
    const blocks = Array.isArray(manifest) ? manifest : [manifest];
    const props = Object.assign({}, ...blocks.map((b) => b.properties));
    const budget = props['spike.monthlyBudget'];
    const mode = props['spike.display.mode'];
    const inspected = cfg().inspect('monthlyBudget');
    must(budget.minimum === 0 && budget.maximum === 100000 && budget.default === 100, 'range/default missing');
    must(deepEq(mode.enum, ['credits', 'cost']) && mode.default === 'credits', 'enum/default missing');
    must(inspected.defaultValue === budget.default, 'inspect().defaultValue !== manifest default');
    must(deepEq(cfg().inspect('rulesApp').defaultValue, props['spike.rulesApp'].default), 'array default mismatch');
    return {
      manifestIsArray: Array.isArray(manifest),
      keysInManifest: Object.keys(props).length,
      monthlyBudget: { default: budget.default, minimum: budget.minimum, maximum: budget.maximum, scope: budget.scope },
      displayMode: { default: mode.default, enum: mode.enum, scope: mode.scope },
      scopesDeclared: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v.scope])),
      arrayItemsSchemaReadable: !!props['spike.rulesApp'].items.properties.metric.enum,
      inspectKeys: Object.keys(inspected).sort(),
    };
  });

  // ---------- 1/2. defaults + mutability ----------
  await check('S4.1a', 'get/inspect return the contributed defaults for array, object, number, enum', async () => {
    const c = cfg();
    const out = {
      rulesApp: c.get('rulesApp'),
      branchBudgets: c.get('branchBudgets'),
      monthlyBudget: c.get('monthlyBudget'),
      mode: c.get('display.mode'),
    };
    must(deepEq(out.rulesApp, []) && deepEq(out.branchBudgets, {}) && out.monthlyBudget === 100 && out.mode === 'credits', JSON.stringify(out));
    const i = c.inspect('rulesApp');
    return { values: out, inspectedGlobalValue: i.globalValue === undefined ? 'undefined' : i.globalValue, defaultValue: i.defaultValue };
  });
  await check('S4.1b', 'returned arrays/objects are read-only proxies (callers must clone before mutating)', async () => {
    await cfg().update('rulesApp', [R1], G);
    await sleep(300);
    const arr = cfg().get('rulesApp');
    const r = {};
    try {
      arr.push({ id: 'x' });
      r.push = 'allowed (mutated returned array)';
    } catch (e) {
      r.push = 'throws: ' + e.message;
    }
    try {
      arr[0].value = 999;
      r.mutateElement = 'allowed';
    } catch (e) {
      r.mutateElement = 'throws: ' + e.message;
    }
    r.afterAttempts = cfg().get('rulesApp')[0].value;
    r.isFrozen = Object.isFrozen(arr);
    await cfg().update('rulesApp', undefined, G);
    return r;
  });

  // ---------- 1. update round trip (Global) + event ----------
  for (const [id, key, scope, value] of [
    ['S4.1c', 'rulesApp', 'application', [R1, R2]],
    ['S4.1d', 'rulesMachine', 'machine', [R1, R2]],
    ['S4.1e', 'targets', 'machine', [{ name: 'prom', url: 'https://example.invalid/write' }, { name: 'hook', url: 'https://example.invalid/hook' }]],
  ]) {
    await check(id, `config.update('${key}', arrayOfObjects, Global) round-trips (scope ${scope}); settings.json holds it; change event fires`, async () => {
      const ev = await observe(() => cfg().update(key, value, G), { expectKey: `spike.${key}` });
      const onDisk = readJsonc(userSettings)[`spike.${key}`];
      const got = cfg().get(key);
      const insp = cfg().inspect(key);
      must(deepEq(onDisk, value), 'file content differs: ' + JSON.stringify(onDisk));
      must(deepEq(got, value), 'get() differs: ' + JSON.stringify(got));
      must(deepEq(insp.globalValue, value), 'inspect().globalValue differs');
      must(ev.fired[`spike.${key}`], 'affectsConfiguration did not fire: ' + JSON.stringify(ev));
      return { roundTrip: true, onDiskEqual: true, eventFired: ev.fired[`spike.${key}`], latencyMs: ev.latencyMs, parentSectionFired: ev.fired['spike'], siblingsFired: Object.entries(ev.fired).filter(([k, v]) => v && k !== `spike.${key}` && k !== 'spike').map(([k]) => k) };
    });
  }
  await check('S4.1f', "update(key, undefined, Global) removes the key from settings.json (reset to default) and fires", async () => {
    const ev = await observe(() => cfg().update('rulesApp', undefined, G), { expectKey: 'spike.rulesApp' });
    const onDisk = readJsonc(userSettings);
    must(!('spike.rulesApp' in onDisk), 'key still on disk');
    must(deepEq(cfg().get('rulesApp'), []), 'default not restored');
    return { keyRemovedFromFile: true, eventFired: ev.fired['spike.rulesApp'], latencyMs: ev.latencyMs };
  });

  // ---------- 1. external edits to settings.json ----------
  await check('S4.1g', 'EXTERNAL edit of settings.json (new array): onDidChangeConfiguration fires with affectsConfiguration("spike.rulesApp")', async () => {
    const base = readJsonc(userSettings);
    const ev = await observe(() => writeUser({ ...base, 'spike.rulesApp': [R1, R2] }), { expectKey: 'spike.rulesApp' });
    must(ev.fired['spike.rulesApp'], 'no event: ' + JSON.stringify(ev));
    must(deepEq(cfg().get('rulesApp'), [R1, R2]), 'get() stale: ' + JSON.stringify(cfg().get('rulesApp')));
    return { eventFired: true, latencyMs: ev.latencyMs, otherKeysFired: Object.entries(ev.fired).filter(([k, v]) => v && k !== 'spike.rulesApp' && k !== 'spike').map(([k]) => k) };
  });
  await check('S4.1h', 'EXTERNAL edit of ONE field of ONE array element: rulesApp fires; unrelated keys do not', async () => {
    const base = readJsonc(userSettings);
    const edited = JSON.parse(JSON.stringify([R1, R2]));
    edited[1].value = 250;
    const ev = await observe(() => writeUser({ ...base, 'spike.rulesApp': edited }), { expectKey: 'spike.rulesApp' });
    must(ev.fired['spike.rulesApp'], 'no event: ' + JSON.stringify(ev));
    must(cfg().get('rulesApp')[1].value === 250, 'value not updated');
    must(!ev.fired['spike.monthlyBudget'] && !ev.fired['spike.rulesMachine'], 'unrelated key reported as affected: ' + JSON.stringify(ev.fired));
    return { rulesAppFired: true, monthlyBudgetFired: ev.fired['spike.monthlyBudget'], rulesMachineFired: ev.fired['spike.rulesMachine'], latencyMs: ev.latencyMs };
  });
  await check('S4.1i', 'EXTERNAL formatting-only rewrite (indent + comment + trailing newline): rulesApp must NOT be reported affected', async () => {
    const base = readJsonc(userSettings);
    const text = '// a comment VS Code must ignore\n' + JSON.stringify(base) + '\n\n';
    const ev = await observe(() => writeUser(text), { waitMs: 2500 });
    return { __status: ev.fired['spike.rulesApp'] ? 'FAIL' : 'PASS', evidence: { rulesAppFired: ev.fired['spike.rulesApp'], anyEventCount: ev.eventCount } };
  });
  await check('S4.1j', 'EXTERNAL property-order change inside array elements: affected or not (informational)', async () => {
    const base = readJsonc(userSettings);
    const reordered = (base['spike.rulesApp'] || []).map((r) => Object.fromEntries(Object.entries(r).reverse()));
    const ev = await observe(() => writeUser({ ...base, 'spike.rulesApp': reordered }), { waitMs: 2500 });
    return { rulesAppFired: ev.fired['spike.rulesApp'], eventCount: ev.eventCount, note: 'if true, consumers must re-evaluate idempotently' };
  });

  // ---------- 1. invalid items (schema violations) ----------
  await check('S4.1k', 'schema-violating items (missing required id, bad enum, wrong types, extra property) are NOT enforced by get(); value passes through verbatim; event still fires', async () => {
    const bad = [
      { metric: 'today.credits', op: '>', value: 1 }, // missing id
      { id: 'b2', metric: 'bogus.metric', op: '~', value: 'abc' }, // bad enum + wrong type
      { id: 'b3', metric: 'today.cost', op: '>', value: 1, unknown: true }, // extra property (additionalProperties:false)
      'not-an-object',
      null,
      42,
    ];
    const base = readJsonc(userSettings);
    const ev = await observe(() => writeUser({ ...base, 'spike.rulesApp': bad }), { expectKey: 'spike.rulesApp' });
    const got = cfg().get('rulesApp');
    must(deepEq(got, bad), 'get() altered the value: ' + JSON.stringify(got));
    return { passedVerbatim: true, eventFired: ev.fired['spike.rulesApp'], got };
  });
  await check('S4.1l', 'config.update() with a schema-violating value is accepted and written (no runtime validation on the write path either)', async () => {
    const bad = [{ id: 1, metric: 7 }];
    await cfg().update('rulesApp', bad, G);
    await sleep(300);
    return { __status: deepEq(readJsonc(userSettings)['spike.rulesApp'], bad) ? 'PASS' : 'FAIL', evidence: { onDisk: readJsonc(userSettings)['spike.rulesApp'] } };
  });
  await check('S4.1m', 'wrong top-level type (string / null / object for an array setting; negative / string for a ranged number; bad enum) is returned verbatim', async () => {
    const out = {};
    for (const [label, key, patch] of [
      ['rulesApp="oops"', 'rulesApp', { 'spike.rulesApp': 'oops' }],
      ['rulesApp=null', 'rulesApp', { 'spike.rulesApp': null }],
      ['rulesApp={}', 'rulesApp', { 'spike.rulesApp': { a: 1 } }],
      ['monthlyBudget=-5', 'monthlyBudget', { 'spike.monthlyBudget': -5 }],
      ['monthlyBudget=1e9', 'monthlyBudget', { 'spike.monthlyBudget': 1e9 }],
      ['monthlyBudget="abc"', 'monthlyBudget', { 'spike.monthlyBudget': 'abc' }],
      ['display.mode="bogus"', 'display.mode', { 'spike.display.mode': 'bogus' }],
    ]) {
      await observe(() => writeUser(patch), { waitMs: 1800 });
      const v = cfg().get(key);
      out[label] = { get: v, typeofGet: v === null ? 'null' : typeof v, isArray: Array.isArray(v) };
    }
    return out;
  });
  await check('S4.1n', 'JSON language service flags the violations (diagnostics on settings.json) but nothing blocks the value', async () => {
    writeUser({
      'spike.rulesApp': [{ metric: 'today.credits', op: '>', value: 1 }, { id: 'b2', metric: 'bogus.metric', op: '~', value: 'abc' }],
      'spike.monthlyBudget': -5,
      'spike.display.mode': 'bogus',
    });
    await sleep(500);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(userSettings));
    await vscode.window.showTextDocument(doc);
    let diags = [];
    for (let i = 0; i < 40 && diags.length === 0; i++) {
      await sleep(250);
      diags = vscode.languages.getDiagnostics(doc.uri);
    }
    await sleep(600);
    diags = vscode.languages.getDiagnostics(doc.uri);
    return {
      __status: diags.length > 0 ? 'PASS' : 'INCONCLUSIVE',
      evidence: { languageId: doc.languageId, count: diags.length, messages: diags.map((d) => `L${d.range.start.line + 1}: ${d.message}`).slice(0, 12) },
    };
  });
  writeUser({});
  await sleep(500);

  // ---------- 2. object-valued settings ----------
  await check('S4.2a', "branchBudgets {branch:number}: update/get/inspect round-trip incl. keys with '/' and '.'; change event; settings.json holds the object", async () => {
    const v = { main: 500, 'feature/x': 100, 'release/1.2': 250 };
    const ev = await observe(() => cfg().update('branchBudgets', v, G), { expectKey: 'spike.branchBudgets' });
    const onDisk = readJsonc(userSettings)['spike.branchBudgets'];
    must(deepEq(cfg().get('branchBudgets'), v), 'get differs: ' + JSON.stringify(cfg().get('branchBudgets')));
    must(deepEq(onDisk, v), 'file differs: ' + JSON.stringify(onDisk));
    must(ev.fired['spike.branchBudgets'], 'event missing');
    return { roundTrip: true, latencyMs: ev.latencyMs, keys: Object.keys(cfg().get('branchBudgets')) };
  });
  await check('S4.2b', 'EXTERNAL edit of one object key: fires affectsConfiguration("spike.branchBudgets")', async () => {
    const base = readJsonc(userSettings);
    const v = { ...base['spike.branchBudgets'], main: 600 };
    const ev = await observe(() => writeUser({ ...base, 'spike.branchBudgets': v }), { expectKey: 'spike.branchBudgets' });
    must(ev.fired['spike.branchBudgets'] && cfg().get('branchBudgets').main === 600, JSON.stringify(ev));
    return { fired: true, latencyMs: ev.latencyMs };
  });
  await check('S4.2c', 'object values violating additionalProperties (string/negative budgets) pass through verbatim', async () => {
    const base = readJsonc(userSettings);
    const v = { main: 'lots', dev: -1, 'x.y': null };
    await observe(() => writeUser({ ...base, 'spike.branchBudgets': v }), { expectKey: 'spike.branchBudgets' });
    return { passedVerbatim: deepEq(cfg().get('branchBudgets'), v), got: cfg().get('branchBudgets') };
  });
  await check('S4.2d', "config.update('branchBudgets.main', 700, Global) (dotted sub-key write): behaviour", async () => {
    writeUser({ 'spike.branchBudgets': { main: 1 } });
    await sleep(600);
    let err = null;
    try {
      await cfg().update('branchBudgets.main', 700, G);
    } catch (e) {
      err = e.message;
    }
    await sleep(500);
    return { error: err, fileAfter: readJsonc(userSettings), getAfter: cfg().get('branchBudgets'), note: 'object settings are replaced wholesale; prefer update("branchBudgets", wholeObject)' };
  });
  writeUser({});
  await sleep(500);

  // ---------- 4. workspace settings: scope behaviour + trust ----------
  await check('S4.4a', 'workspace .vscode/settings.json: which scopes are applied (application/machine ignored?), effective get() and inspect().workspaceValue', async () => {
    fs.mkdirSync(path.dirname(wsSettings), { recursive: true });
    const W = [{ id: 'ws', value: 1 }];
    const wsRules = [{ id: 'ws', metric: 'today.credits', op: '>', value: 1 }];
    const payload = {
      'spike.rulesApp': wsRules,
      'spike.rulesMachine': wsRules,
      'spike.targets': [{ name: 'ws', url: 'https://ws.invalid' }],
      'spike.branchBudgets': { wsBranch: 1 },
      'spike.monthlyBudget': 7,
      'spike.display.mode': 'cost',
      'spike.rulesResource': W,
      'spike.rulesMachineOverridable': W,
      'spike.rulesWindow': W,
      'spike.rulesLang': W,
    };
    const ev = await observe(() => fs.writeFileSync(wsSettings, JSON.stringify(payload, null, 2)), { waitMs: 3500 });
    const table = {};
    for (const key of ['rulesApp', 'rulesMachine', 'targets', 'branchBudgets', 'monthlyBudget', 'display.mode', 'rulesResource', 'rulesMachineOverridable', 'rulesWindow', 'rulesLang']) {
      const i = cfg().inspect(key);
      const declared = Object.assign({}, ...(Array.isArray(vscode.extensions.getExtension(extensionId).packageJSON.contributes.configuration) ? vscode.extensions.getExtension(extensionId).packageJSON.contributes.configuration : [vscode.extensions.getExtension(extensionId).packageJSON.contributes.configuration]).map((b) => b.properties))[`spike.${key}`];
      table[key] = { scope: declared.scope, workspaceValueApplied: i.workspaceValue !== undefined, effectiveEqualsWorkspace: deepEq(cfg().get(key), payload[`spike.${key}`]) };
    }
    return { isTrusted: vscode.workspace.isTrusted, trustLabel, workspaceFolders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath), anyEventFired: ev.eventCount > 0, table };
  });
  await check('S4.4b', 'diagnostics on workspace .vscode/settings.json for scopes that cannot be applied in a workspace (warning text)', async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(wsSettings));
    await vscode.window.showTextDocument(doc);
    let diags = [];
    for (let i = 0; i < 40 && diags.length === 0; i++) {
      await sleep(250);
      diags = vscode.languages.getDiagnostics(doc.uri);
    }
    await sleep(800);
    diags = vscode.languages.getDiagnostics(doc.uri);
    return { __status: diags.length > 0 ? 'PASS' : 'INCONCLUSIVE', evidence: diags.map((d) => `L${d.range.start.line + 1} sev${d.severity}: ${d.message}`) };
  });
  await check('S4.4c', "config.update(..., ConfigurationTarget.Workspace) for application/machine/resource scope: allowed or rejected", async () => {
    const out = {};
    for (const key of ['rulesApp', 'rulesMachine', 'rulesResource', 'rulesWindow']) {
      try {
        await cfg().update(key, [{ id: 'x', value: 2 }], vscode.ConfigurationTarget.Workspace);
        out[key] = 'accepted';
      } catch (e) {
        out[key] = 'rejected: ' + e.message;
      }
    }
    return out;
  });
  await check('S4.4d', 'workspace edit of resource-scope array fires onDidChangeConfiguration', async () => {
    const cur = readJsonc(wsSettings);
    const ev = await observe(() => fs.writeFileSync(wsSettings, JSON.stringify({ ...cur, 'spike.rulesResource': [{ id: 'ws2', value: 3 }] })), { expectKey: 'spike.rulesResource' });
    return { __status: ev.fired['spike.rulesResource'] ? 'PASS' : 'FAIL', evidence: { fired: ev.fired['spike.rulesResource'], latencyMs: ev.latencyMs } };
  });

  // ---------- misc: affectsConfiguration granularity ----------
  await check('S4.misc1', 'affectsConfiguration granularity: parent section "spike" and exact key; sibling keys unaffected', async () => {
    writeUser({});
    await sleep(600);
    const ev = await observe(() => cfg().update('monthlyBudget', 200, G), { expectKey: 'spike.monthlyBudget' });
    return { monthlyBudget: ev.fired['spike.monthlyBudget'], spike: ev.fired['spike'], rulesApp: ev.fired['spike.rulesApp'], branchBudgets: ev.fired['spike.branchBudgets'], displayModeSection: ev.fired['spike.display'] };
  });
  await check('S4.misc2', 'getConfiguration("spike") object: keys visible (for table-driven reads)', async () => {
    return { keys: Object.keys(cfg()).sort() };
  });

  writeUser({});
  return results;
}

module.exports = { runSettingsChecks };
