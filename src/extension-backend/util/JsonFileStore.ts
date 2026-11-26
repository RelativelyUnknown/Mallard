/**
 * Shared best-effort JSON file persistence. The stores (RestrictionEngine,
 * ExportQueue) used to hand-roll the same readFileSync/
 * writeFileSync + try/catch idiom; this centralises it with logging instead
 * of silence. Failure semantics stay the owners': read() returns undefined on
 * any failure (missing file, bad JSON) so each caller applies its own
 * fallback, and write() is best-effort.
 *
 * Writes are atomic (temp file + rename), so a crash or a concurrent reader
 * never sees a half-written file.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import * as path from 'path';
import { defaultLogger, Logger } from './logger';

export class JsonFileStore<T> {
  readonly file: string;

  constructor(
    dir: string,
    fileName: string,
    private readonly logger: Logger = defaultLogger,
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, fileName);
  }

  /** Parsed file contents, or undefined when missing/unreadable/malformed. */
  read(): unknown | undefined {
    const text = this.readText();
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      this.logger.debug('store', `unreadable JSON at ${this.file}; using fallback`, err);
      return undefined;
    }
  }

  /** Raw file text, or undefined when the file is missing/unreadable. */
  readText(): string | undefined {
    try {
      return readFileSync(this.file, 'utf8');
    } catch (err) {
      // Missing file is the common first-run case — stay quiet about ENOENT.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.debug('store', `unreadable file at ${this.file}; using fallback`, err);
      }
      return undefined;
    }
  }

  /**
   * Pretty-printed atomic write (temp file + rename); best-effort (in-memory
   * state still applies on failure). Returns the exact text written so callers
   * can recognise their own write when the file watcher reports it, or
   * undefined when the write failed.
   */
  write(value: T): string | undefined {
    const text = JSON.stringify(value, null, 2) + '\n';
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, text, 'utf8');
      renameSync(tmp, this.file);
      return text;
    } catch (err) {
      this.logger.warn('store', `failed to persist ${this.file}`, err);
      try {
        unlinkSync(tmp);
      } catch {
        /* the temp file may never have been created */
      }
      return undefined;
    }
  }
}
