import { describe, expect, it } from 'vitest';
import { SessionLogger } from './session-logger.js';
import type { LogLevel } from './session-logger.js';

/** Collect log lines in an array for assertion. */
function createSink(): { lines: string[]; writer: (line: string) => void } {
  const lines: string[] = [];
  return { lines, writer: (line: string) => lines.push(line) };
}

/** Fixed clock for deterministic timestamps. */
const FIXED_CLOCK = () => '2026-01-15T10:30:00.000Z';

/** Fixed correlation ID for deterministic output. */
const FIXED_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('SessionLogger', () => {
  describe('construction', () => {
    it('mints a correlation ID when none is provided', () => {
      const logger = new SessionLogger({ writer: () => {} });
      expect(logger.getCorrelationId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('uses the provided correlation ID', () => {
      const logger = new SessionLogger({ correlationId: FIXED_ID, writer: () => {} });
      expect(logger.getCorrelationId()).toBe(FIXED_ID);
    });

    it('defaults to info level', () => {
      const logger = new SessionLogger({ writer: () => {} });
      expect(logger.getLevel()).toBe('info');
    });
  });

  describe('level filtering', () => {
    it('emits entries at or above the minimum level', () => {
      const sink = createSink();
      const logger = new SessionLogger({
        level: 'info',
        writer: sink.writer,
        correlationId: FIXED_ID,
        now: FIXED_CLOCK,
      });

      logger.debug('should be hidden');
      logger.info('should appear');
      logger.warn('should appear');
      logger.error('should appear');

      expect(sink.lines).toHaveLength(3);
    });

    it('emits all entries at debug level', () => {
      const sink = createSink();
      const logger = new SessionLogger({
        level: 'debug',
        writer: sink.writer,
        correlationId: FIXED_ID,
        now: FIXED_CLOCK,
      });

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(sink.lines).toHaveLength(4);
    });

    it('emits only error entries at error level', () => {
      const sink = createSink();
      const logger = new SessionLogger({
        level: 'error',
        writer: sink.writer,
        correlationId: FIXED_ID,
        now: FIXED_CLOCK,
      });

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(sink.lines).toHaveLength(1);
      expect(sink.lines[0]).toContain('[ERROR]');
    });
  });

  describe('setLevel', () => {
    it('changes the minimum level at runtime', () => {
      const sink = createSink();
      const logger = new SessionLogger({
        level: 'error',
        writer: sink.writer,
        correlationId: FIXED_ID,
        now: FIXED_CLOCK,
      });

      logger.info('hidden');
      expect(sink.lines).toHaveLength(0);

      logger.setLevel('debug');
      logger.info('visible');
      expect(sink.lines).toHaveLength(1);
    });
  });

  describe('text format', () => {
    it('produces human-readable lines', () => {
      const sink = createSink();
      const logger = new SessionLogger({
        format: 'text',
        writer: sink.writer,
        correlationId: FIXED_ID,
        now: FIXED_CLOCK,
      });

      logger.info('Iteration 3 completed');
      expect(sink.lines[0]).toBe(
        '2026-01-15T10:30:00.000Z [INFO] (aaaaaaaa) Iteration 3 completed',
      );
    });

    it('appends JSON data when provided', () => {
      const sink = createSink();
      const logger = new SessionLogger({
        format: 'text',
        writer: sink.writer,
        correlationId: FIXED_ID,
        now: FIXED_CLOCK,
      });

      logger.info('Test passed', { testId: 't-123', duration: 4500 });
      expect(sink.lines[0]).toContain('{"testId":"t-123","duration":4500}');
    });

    it('includes the correct level tag for each level', () => {
      const sink = createSink();
      const logger = new SessionLogger({
        format: 'text',
        level: 'debug',
        writer: sink.writer,
        correlationId: FIXED_ID,
        now: FIXED_CLOCK,
      });

      const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
      for (const lvl of levels) logger[lvl](`msg-${lvl}`);

      expect(sink.lines[0]).toContain('[DEBUG]');
      expect(sink.lines[1]).toContain('[INFO]');
      expect(sink.lines[2]).toContain('[WARN]');
      expect(sink.lines[3]).toContain('[ERROR]');
    });
  });

  describe('JSONL format', () => {
    it('produces valid JSON per line', () => {
      const sink = createSink();
      const logger = new SessionLogger({
        format: 'jsonl',
        writer: sink.writer,
        correlationId: FIXED_ID,
        now: FIXED_CLOCK,
      });

      logger.info('Starting session');
      const entry = JSON.parse(sink.lines[0]!);
      expect(entry.timestamp).toBe('2026-01-15T10:30:00.000Z');
      expect(entry.level).toBe('info');
      expect(entry.message).toBe('Starting session');
      expect(entry.correlationId).toBe(FIXED_ID);
    });

    it('includes data field when provided', () => {
      const sink = createSink();
      const logger = new SessionLogger({
        format: 'jsonl',
        writer: sink.writer,
        correlationId: FIXED_ID,
        now: FIXED_CLOCK,
      });

      logger.info('Progress', { iteration: 5, progress: 0.42 });
      const entry = JSON.parse(sink.lines[0]!);
      expect(entry.data).toEqual({ iteration: 5, progress: 0.42 });
    });

    it('omits data field when not provided', () => {
      const sink = createSink();
      const logger = new SessionLogger({
        format: 'jsonl',
        writer: sink.writer,
        correlationId: FIXED_ID,
        now: FIXED_CLOCK,
      });

      logger.info('No data');
      const entry = JSON.parse(sink.lines[0]!);
      expect(entry.data).toBeUndefined();
    });
  });

  describe('secret redaction', () => {
    it('redacts API keys from messages', () => {
      const sink = createSink();
      const logger = new SessionLogger({
        format: 'text',
        writer: sink.writer,
        correlationId: FIXED_ID,
        now: FIXED_CLOCK,
      });

      logger.info('Using key sk-abcdef1234567890abcdef');
      expect(sink.lines[0]).toContain('[REDACTED:api-key]');
      expect(sink.lines[0]).not.toContain('sk-abcdef');
    });

    it('redacts secrets in data values', () => {
      const sink = createSink();
      const logger = new SessionLogger({
        format: 'jsonl',
        writer: sink.writer,
        correlationId: FIXED_ID,
        now: FIXED_CLOCK,
      });

      logger.info('Config loaded', { apiKey: 'sk-abcdef1234567890abcdef' });
      const entry = JSON.parse(sink.lines[0]!);
      expect(entry.data.apiKey).toBe('[REDACTED:api-key]');
    });

    it('redacts secrets in nested data objects', () => {
      const sink = createSink();
      const logger = new SessionLogger({
        format: 'jsonl',
        writer: sink.writer,
        correlationId: FIXED_ID,
        now: FIXED_CLOCK,
      });

      logger.info('Deep config', {
        connection: {
          url: 'https://admin:supersecretpassword@db.example.com',
        },
      });
      const entry = JSON.parse(sink.lines[0]!);
      expect(entry.data.connection.url).toContain('[REDACTED:url-password]');
      expect(entry.data.connection.url).not.toContain('supersecretpassword');
    });

    it('redacts secrets in arrays within data', () => {
      const sink = createSink();
      const logger = new SessionLogger({
        format: 'jsonl',
        writer: sink.writer,
        correlationId: FIXED_ID,
        now: FIXED_CLOCK,
      });

      logger.info('Keys', { keys: ['sk-abcdef1234567890abcdef', 'safe-value'] });
      const entry = JSON.parse(sink.lines[0]!);
      expect(entry.data.keys[0]).toBe('[REDACTED:api-key]');
      expect(entry.data.keys[1]).toBe('safe-value');
    });

    it('preserves non-string data values', () => {
      const sink = createSink();
      const logger = new SessionLogger({
        format: 'jsonl',
        writer: sink.writer,
        correlationId: FIXED_ID,
        now: FIXED_CLOCK,
      });

      logger.info('Metrics', { count: 42, active: true, value: null });
      const entry = JSON.parse(sink.lines[0]!);
      expect(entry.data.count).toBe(42);
      expect(entry.data.active).toBe(true);
      expect(entry.data.value).toBeNull();
    });
  });

  describe('child logger', () => {
    it('creates a child with a new correlation ID', () => {
      const sink = createSink();
      const parent = new SessionLogger({
        format: 'jsonl',
        writer: sink.writer,
        correlationId: FIXED_ID,
        now: FIXED_CLOCK,
      });

      const child = parent.child('child-id-12345678');
      child.info('From child');

      const entry = JSON.parse(sink.lines[0]!);
      expect(entry.correlationId).toBe('child-id-12345678');
    });

    it('inherits the parent writer', () => {
      const sink = createSink();
      const parent = new SessionLogger({
        writer: sink.writer,
        correlationId: FIXED_ID,
        now: FIXED_CLOCK,
      });

      const child = parent.child();
      child.info('Child message');

      expect(sink.lines).toHaveLength(1);
      expect(sink.lines[0]).toContain('Child message');
    });

    it('inherits the parent level', () => {
      const sink = createSink();
      const parent = new SessionLogger({
        level: 'warn',
        writer: sink.writer,
        correlationId: FIXED_ID,
        now: FIXED_CLOCK,
      });

      const child = parent.child();
      child.info('hidden');
      child.warn('visible');

      expect(sink.lines).toHaveLength(1);
    });

    it('mints a UUID when no child ID is provided', () => {
      const parent = new SessionLogger({ writer: () => {} });
      const child = parent.child();
      expect(child.getCorrelationId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(child.getCorrelationId()).not.toBe(parent.getCorrelationId());
    });
  });
});
