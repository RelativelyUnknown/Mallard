/**
 * Holds the live {@link Exporter} and swaps it for a freshly built one when its
 * inputs change (transport/auth/URL/certificate settings, credentials, fan-out
 * targets) — these used to silently require a window reload. Consumers read
 * {@link current} per call, so they pick up a replacement immediately.
 *
 * Rebuilds are chained, so overlapping triggers (a settings edit plus the three
 * secret writes of "Manage Credentials") apply in order instead of racing — the
 * last one built is the one left installed. An exporter that finishes building
 * after {@link close} is disposed rather than installed.
 */
import { defaultLogger, Logger } from '../util/logger';
import type { Exporter } from './MetricExporter';

export class ExporterRebuilder {
  private exporter: Exporter;
  private closed = false;
  private rebuilding: Promise<void> = Promise.resolve();

  constructor(
    initial: Exporter,
    /** Builds an exporter from the settings and credentials as they are now. */
    private readonly build: () => Promise<Exporter>,
    private readonly logger: Logger = defaultLogger,
  ) {
    this.exporter = initial;
  }

  /** The exporter to send to right now. */
  get current(): Exporter {
    return this.exporter;
  }

  /** Queue a rebuild behind any in flight; failures are logged and never break the chain. */
  scheduleRebuild(): void {
    this.rebuilding = this.rebuilding
      .then(() => this.rebuild())
      .catch((err: unknown) => this.logger.error('export', 'exporter rebuild failed', err));
  }

  /** Dispose the live exporter and refuse any rebuild still in flight. */
  close(): void {
    this.closed = true;
    this.exporter.dispose();
  }

  private async rebuild(): Promise<void> {
    const next = await this.build();
    if (this.closed) {
      next.dispose(); // the extension shut down while this was building
      return;
    }
    const old = this.exporter;
    this.exporter = next;
    old.dispose();
  }
}
