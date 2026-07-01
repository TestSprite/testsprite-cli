/**
 * Structured session logger for long-running CLI operations.
 *
 * Produces timestamped, levelled log entries with correlation IDs in
 * both human-readable (text) and machine-readable (JSONL) formats.
 * Every entry is automatically redacted through the secret-redaction
 * pipeline before it reaches any output sink.
 *
 * Design notes:
 *   - The logger is intentionally decoupled from any specific CLI
 *     command. It can be used by target-mode sessions, test runs, or
 *     any future feature that benefits from structured observability.
 *   - Writers are injectable: tests supply an in-memory sink; the CLI
 *     wires stderr or a file writer. This keeps the module testable
 *     without touching the filesystem or real I/O.
 *   - Correlation IDs are minted per-session and can be overridden
 *     per-entry so that iteration-scoped sub-operations share a
 *     traceable identifier.
 *   - `redactSecrets` runs on every emitted string — callers never
 *     need to worry about scrubbing secrets before logging.
 *   - Log levels follow the conventional four-tier model:
 *     `debug < info < warn < error`. The minimum level is configurable
 *     at construction and can be changed at runtime.
 *   - This module has zero external dependencies beyond `redact.ts` and
 *     Node's `crypto.randomUUID`.
 */

import { randomUUID } from 'node:crypto';
import { redactSecrets } from './redact.js';
import type { RedactionPattern } from './redact.js';
import { createRedactor } from './redact.js';

// ────────────────────────── Types ──────────────────────────

/** Supported log levels, ordered by severity. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Numeric weight for level comparison. Higher = more severe. */
const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** A single structured log entry. */
export interface LogEntry {
  /** ISO 8601 timestamp of when the entry was created. */
  timestamp: string;
  /** Log severity level. */
  level: LogLevel;
  /** Human-readable message (already redacted). */
  message: string;
  /** Session-scoped or entry-scoped correlation ID. */
  correlationId: string;
  /** Optional structured data attached to the entry. */
  data?: Record<string, unknown>;
}

/**
 * Sink that receives formatted log output. Inject a custom writer
 * for tests or file-based logging.
 */
export type LogWriter = (line: string) => void;

/** Output format for log entries. */
export type LogFormat = 'text' | 'jsonl';

/** Configuration for creating a session logger. */
export interface SessionLoggerOptions {
  /**
   * Minimum severity to emit. Entries below this level are silently
   * discarded. Default: `'info'`.
   */
  level?: LogLevel;
  /**
   * Output format. `'text'` emits human-readable lines suitable for
   * terminal / stderr; `'jsonl'` emits one JSON object per line for
   * machine consumption. Default: `'text'`.
   */
  format?: LogFormat;
  /**
   * Writer function that receives each formatted line. Default:
   * `process.stderr.write` (line + newline).
   */
  writer?: LogWriter;
  /**
   * Session-wide correlation ID. When omitted a new UUID is minted.
   * Pass an explicit ID when resuming a checkpointed session so log
   * entries share the same trace.
   */
  correlationId?: string;
  /**
   * Additional redaction patterns prepended to the built-in defaults.
   * Use for project-specific secret formats.
   */
  extraRedactPatterns?: readonly RedactionPattern[];
  /**
   * Injectable clock for deterministic tests.
   * Default: `() => new Date().toISOString()`.
   */
  now?: () => string;
}

// ────────────────────────── Logger ──────────────────────────

export class SessionLogger {
  private minLevel: LogLevel;
  private readonly format: LogFormat;
  private readonly writer: LogWriter;
  private readonly correlationId: string;
  private readonly redact: (input: string) => string;
  private readonly now: () => string;

  constructor(options: SessionLoggerOptions = {}) {
    this.minLevel = options.level ?? 'info';
    this.format = options.format ?? 'text';
    this.writer =
      options.writer ??
      ((line: string) => {
        process.stderr.write(`${line}\n`);
      });
    this.correlationId = options.correlationId ?? randomUUID();
    this.redact =
      options.extraRedactPatterns && options.extraRedactPatterns.length > 0
        ? createRedactor(options.extraRedactPatterns)
        : redactSecrets;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** The session correlation ID assigned to this logger instance. */
  getCorrelationId(): string {
    return this.correlationId;
  }

  /** Update the minimum log level at runtime. */
  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  /** Get the current minimum log level. */
  getLevel(): LogLevel {
    return this.minLevel;
  }

  /**
   * Emit a debug-level entry. Use for internal state transitions,
   * iteration details, and data an operator only needs when
   * troubleshooting.
   */
  debug(message: string, data?: Record<string, unknown>): void {
    this.emit('debug', message, data);
  }

  /**
   * Emit an info-level entry. Use for routine progress updates,
   * milestones, and state changes that are useful during normal
   * operation.
   */
  info(message: string, data?: Record<string, unknown>): void {
    this.emit('info', message, data);
  }

  /**
   * Emit a warn-level entry. Use for degraded conditions that do not
   * stop the session but may warrant attention — e.g. TTS failure
   * fallback, browser reconnection, or approaching a budget limit.
   */
  warn(message: string, data?: Record<string, unknown>): void {
    this.emit('warn', message, data);
  }

  /**
   * Emit an error-level entry. Use for failures that stop or block
   * the current operation — e.g. unrecoverable errors, exceeded
   * limits, or fatal validation failures.
   */
  error(message: string, data?: Record<string, unknown>): void {
    this.emit('error', message, data);
  }

  /**
   * Create a child logger that inherits all settings but uses a
   * different correlation ID. Useful for scoping log entries to a
   * specific iteration or sub-operation within a session.
   */
  child(correlationId?: string): SessionLogger {
    return new SessionLogger({
      level: this.minLevel,
      format: this.format,
      writer: this.writer,
      correlationId: correlationId ?? randomUUID(),
      now: this.now,
    });
  }

  // ─────────────────── Internal ───────────────────

  private emit(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) return;

    const entry: LogEntry = {
      timestamp: this.now(),
      level,
      message: this.redact(message),
      correlationId: this.correlationId,
    };

    if (data !== undefined) {
      // Deep-redact all string values in the data object.
      entry.data = this.redactData(data);
    }

    this.writer(this.formatEntry(entry));
  }

  private formatEntry(entry: LogEntry): string {
    if (this.format === 'jsonl') {
      return JSON.stringify(entry);
    }

    // Text format: `2024-01-15T10:30:00Z [INFO] (abc123) Message`
    const levelTag = `[${entry.level.toUpperCase()}]`;
    const shortId = entry.correlationId.slice(0, 8);
    const dataStr = entry.data !== undefined ? ` ${JSON.stringify(entry.data)}` : '';
    return `${entry.timestamp} ${levelTag} (${shortId}) ${entry.message}${dataStr}`;
  }

  /**
   * Recursively redact string values inside a data object.
   * Non-string primitives, arrays, and nested objects are traversed;
   * only string leaves are passed through the redactor.
   */
  private redactData(data: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string') {
        result[key] = this.redact(value);
      } else if (Array.isArray(value)) {
        result[key] = value.map(item =>
          typeof item === 'string'
            ? this.redact(item)
            : item !== null && typeof item === 'object'
              ? this.redactData(item as Record<string, unknown>)
              : item,
        );
      } else if (value !== null && typeof value === 'object') {
        result[key] = this.redactData(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}
