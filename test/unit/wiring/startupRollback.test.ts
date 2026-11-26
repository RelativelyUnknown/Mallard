import { strict as assert } from 'assert';
import { withStartupRollback } from '../../../src/extension-backend/wiring/startupRollback';

function recordingLogger() {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      debug() {},
      info() {},
      error() {},
      warn: (_tag: string, msg: string) => void warnings.push(msg),
    },
  };
}

describe('withStartupRollback', () => {
  it('returns the startup result and leaves everything registered on success', async () => {
    const order: string[] = [];
    const subscriptions = [{ dispose: () => void order.push('existing') }];
    const result = await withStartupRollback(subscriptions, async (started) => {
      started.push(() => order.push('started'));
      subscriptions.push({ dispose: () => void order.push('added') });
      return 42;
    });
    assert.equal(result, 42);
    assert.equal(subscriptions.length, 2);
    assert.deepEqual(order, [], 'nothing is disposed when startup succeeds');
  });

  it('on failure runs the started cleanups in reverse, then the new subscriptions in reverse, and rethrows', async () => {
    const order: string[] = [];
    const subscriptions = [{ dispose: () => void order.push('existing') }];
    const boom = new Error('boom');
    await assert.rejects(
      withStartupRollback(subscriptions, async (started) => {
        started.push(() => order.push('started-1'), () => order.push('started-2'));
        subscriptions.push(
          { dispose: () => void order.push('sub-1') },
          { dispose: () => void order.push('sub-2') },
        );
        throw boom;
      }),
      (err) => err === boom,
    );
    assert.deepEqual(order, ['started-2', 'started-1', 'sub-2', 'sub-1']);
    assert.equal(subscriptions.length, 1, 'only the subscriptions this attempt registered are removed');
    assert.equal(order.includes('existing'), false, 'pre-existing subscriptions are untouched');
  });

  it('keeps cleaning up after one cleanup throws, logging it, and still rethrows the original error', async () => {
    const order: string[] = [];
    const { logger, warnings } = recordingLogger();
    const subscriptions: Array<{ dispose(): unknown }> = [];
    const original = new Error('startup failed');
    await assert.rejects(
      withStartupRollback(
        subscriptions,
        async (started) => {
          started.push(() => order.push('first'));
          started.push(() => {
            throw new Error('cleanup failed');
          });
          subscriptions.push({ dispose: () => void order.push('subscription') });
          throw original;
        },
        logger,
      ),
      (err) => err === original,
    );
    assert.deepEqual(order, ['first', 'subscription'], 'the throwing cleanup (run first, in reverse) did not stop the rest');
    assert.deepEqual(warnings, ['cleanup after failed startup threw']);
  });
});
