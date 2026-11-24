/* c8 ignore next */
export interface Logger {
  debug(tag: string, msg: string, ...args: unknown[]): void;
  info(tag: string, msg: string, ...args: unknown[]): void;
  warn(tag: string, msg: string, ...args: unknown[]): void;
  error(tag: string, msg: string, ...args: unknown[]): void;
}

/**
 * Anything that can show a line of text — structurally a vscode.OutputChannel,
 * without this module (also bundled outside the extension host) importing vscode.
 */
export interface LogSink {
  appendLine(line: string): void;
}

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? arg.message;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

export class ConsoleLogger implements Logger {
  private sink: LogSink | undefined;

  /**
   * Mirror info/warn/error lines into `sink` (the "Mallard" Output channel) so
   * messages that say "see the Output panel" are true. Returns a function that
   * detaches it. debug stays console-only — it is too chatty for users.
   */
  attachSink(sink: LogSink): () => void {
    this.sink = sink;
    return () => {
      if (this.sink === sink) this.sink = undefined;
    };
  }

  private mirror(level: string, tag: string, msg: string, args: unknown[]): void {
    if (!this.sink) return;
    const rest = args.map(formatArg).join(' ');
    try {
      this.sink.appendLine(`${new Date().toISOString()} [${level}] [${tag}] ${msg}${rest ? ' ' + rest : ''}`);
    } catch {
      /* logging must never throw (e.g. the channel was already disposed) */
    }
  }

  debug(tag: string, msg: string, ...args: unknown[]): void {
    console.debug(`[mallard:${tag}]`, msg, ...args);
  }
  info(tag: string, msg: string, ...args: unknown[]): void {
    console.log(`[mallard:${tag}]`, msg, ...args);
    this.mirror('info', tag, msg, args);
  }
  warn(tag: string, msg: string, ...args: unknown[]): void {
    console.warn(`[mallard:${tag}]`, msg, ...args);
    this.mirror('warn', tag, msg, args);
  }
  error(tag: string, msg: string, ...args: unknown[]): void {
    console.error(`[mallard:${tag}]`, msg, ...args);
    this.mirror('error', tag, msg, args);
  }
}

/* c8 ignore next */
export const defaultLogger = new ConsoleLogger();
