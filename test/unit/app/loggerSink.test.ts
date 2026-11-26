import { strict as assert } from 'assert';
import { ConsoleLogger } from '../../../src/extension-backend/util/logger';

describe('ConsoleLogger — Output channel sink', () => {
  function quiet<T>(fn: () => T): T {
    const orig = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
    console.log = console.warn = console.error = console.debug = () => {};
    try {
      return fn();
    } finally {
      Object.assign(console, orig);
    }
  }

  it('mirrors info/warn/error (not debug) into the attached sink with level, tag and detail', () => {
    const lines: string[] = [];
    const logger = new ConsoleLogger();
    logger.attachSink({ appendLine: (l) => void lines.push(l) });
    quiet(() => {
      logger.debug('t', 'noisy');
      logger.info('store', 'opened');
      logger.warn('config', 'bad block', 'rules');
      logger.error('export', 'failed', new Error('boom'));
    });
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /\[info\] \[store\] opened$/);
    assert.match(lines[1]!, /\[warn\] \[config\] bad block rules$/);
    assert.match(lines[2]!, /\[error\] \[export\] failed Error: boom/);
  });

  it('stops mirroring once detached, and never throws if the sink does', () => {
    const lines: string[] = [];
    const logger = new ConsoleLogger();
    const detach = logger.attachSink({ appendLine: (l) => void lines.push(l) });
    detach();
    quiet(() => logger.info('t', 'after detach'));
    assert.deepEqual(lines, []);

    logger.attachSink({
      appendLine: () => {
        throw new Error('channel disposed');
      },
    });
    assert.doesNotThrow(() => quiet(() => logger.error('t', 'still fine')));
  });

  it('formats non-string arguments without throwing on circular structures', () => {
    const lines: string[] = [];
    const logger = new ConsoleLogger();
    logger.attachSink({ appendLine: (l) => void lines.push(l) });
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    quiet(() => logger.warn('t', 'odd', { a: 1 }, circular, 42));
    assert.match(lines[0]!, /\{"a":1\}/);
    assert.match(lines[0]!, /42$/);
  });
});
