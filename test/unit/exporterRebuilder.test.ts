import { strict as assert } from 'assert';
import { ExporterRebuilder } from '../../src/extension-backend/export/ExporterRebuilder';
import type { Exporter } from '../../src/extension-backend/export/MetricExporter';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function fakeExporter(name: string, log: string[]): Exporter {
  return { export: async () => {}, dispose: () => void log.push(`dispose ${name}`) };
}

function silentLogger() {
  const errors: string[] = [];
  return {
    errors,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error: (_tag: string, msg: string) => void errors.push(msg),
    },
  };
}

describe('ExporterRebuilder', () => {
  it('exposes the initial exporter until a rebuild lands, then swaps and disposes the old one', async () => {
    const log: string[] = [];
    const first = fakeExporter('first', log);
    const second = fakeExporter('second', log);
    const rebuilder = new ExporterRebuilder(first, async () => second);

    assert.equal(rebuilder.current, first);
    rebuilder.scheduleRebuild();
    await tick();

    assert.equal(rebuilder.current, second);
    assert.deepEqual(log, ['dispose first']);
  });

  it('serialises overlapping rebuilds: they build one at a time, in order, and the last one stays installed', async () => {
    const log: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let built = 0;
    const rebuilder = new ExporterRebuilder(fakeExporter('0', log), async () => {
      const id = ++built;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(5);
      inFlight--;
      return fakeExporter(String(id), log);
    });

    rebuilder.scheduleRebuild();
    rebuilder.scheduleRebuild();
    rebuilder.scheduleRebuild();
    await tick(60);

    assert.equal(maxInFlight, 1, 'never two builds at once');
    assert.equal(built, 3);
    assert.deepEqual(log, ['dispose 0', 'dispose 1', 'dispose 2']);
    rebuilder.close();
    assert.deepEqual(log.at(-1), 'dispose 3', 'the last build is the one left installed (and closed)');
  });

  it('logs a failed rebuild, keeps the current exporter, and still runs later rebuilds', async () => {
    const log: string[] = [];
    const { logger, errors } = silentLogger();
    const first = fakeExporter('first', log);
    const next = fakeExporter('next', log);
    let call = 0;
    const rebuilder = new ExporterRebuilder(
      first,
      async () => {
        if (++call === 1) throw new Error('credentials unavailable');
        return next;
      },
      logger,
    );

    rebuilder.scheduleRebuild();
    await tick();
    assert.equal(rebuilder.current, first, 'a failed build leaves the working exporter in place');
    assert.deepEqual(errors, ['exporter rebuild failed']);

    rebuilder.scheduleRebuild();
    await tick();
    assert.equal(rebuilder.current, next, 'the chain was not broken by the failure');
  });

  it('close() disposes the live exporter, and an exporter finishing its build afterwards is disposed, not installed', async () => {
    const log: string[] = [];
    const first = fakeExporter('first', log);
    const late = fakeExporter('late', log);
    const rebuilder = new ExporterRebuilder(first, async () => {
      await tick(15);
      return late;
    });

    rebuilder.scheduleRebuild();
    rebuilder.close(); // shut down while the rebuild is still building
    assert.deepEqual(log, ['dispose first']);

    await tick(40);
    assert.deepEqual(log, ['dispose first', 'dispose late']);
    assert.equal(rebuilder.current, first, 'the late exporter was never installed');
  });
});
