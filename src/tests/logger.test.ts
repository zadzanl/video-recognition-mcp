/**
 * Logger transport safety tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, LogLevel, Logger } from '../utils/logger.js';

describe('Logger stderr safety', () => {
  it('routes verbose and info logs to stderr only', () => {
    Logger.setLogLevel(LogLevel.VERBOSE);

    const originalLog = console.log;
    const originalError = console.error;
    const logCalls: unknown[][] = [];
    const errorCalls: unknown[][] = [];

    console.log = (...args: unknown[]): void => {
      logCalls.push(args);
    };
    console.error = (...args: unknown[]): void => {
      errorCalls.push(args);
    };

    try {
      const logger = createLogger('Test');
      logger.verbose('verbose message');
      logger.info('info message');

      assert.strictEqual(logCalls.length, 0);
      assert.strictEqual(errorCalls.length, 2);
      assert.match(String(errorCalls[0]?.[0] ?? ''), /\[VERBOSE\]/);
      assert.match(String(errorCalls[1]?.[0] ?? ''), /\[INFO\]/);
    } finally {
      console.log = originalLog;
      console.error = originalError;
      Logger.setLogLevel(LogLevel.FATAL);
    }
  });

  it('routes warn, error, and fatal logs to stderr only', () => {
    Logger.setLogLevel(LogLevel.VERBOSE);

    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const logCalls: unknown[][] = [];
    const warnCalls: unknown[][] = [];
    const errorCalls: unknown[][] = [];

    console.log = (...args: unknown[]): void => {
      logCalls.push(args);
    };
    console.warn = (...args: unknown[]): void => {
      warnCalls.push(args);
    };
    console.error = (...args: unknown[]): void => {
      errorCalls.push(args);
    };

    try {
      const logger = createLogger('Test');
      logger.warn('warn message');
      logger.error('error message');
      logger.fatal('fatal message');

      assert.strictEqual(logCalls.length, 0);
      assert.strictEqual(warnCalls.length, 0);
      assert.strictEqual(errorCalls.length, 3);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
      Logger.setLogLevel(LogLevel.FATAL);
    }
  });

  it('does not throw when logging circular objects or bigint values', () => {
    Logger.setLogLevel(LogLevel.VERBOSE);

    const originalError = console.error;
    const errorCalls: unknown[][] = [];
    const circular: { self?: unknown } = {};
    circular.self = circular;

    console.error = (...args: unknown[]): void => {
      errorCalls.push(args);
    };

    try {
      const logger = createLogger('Test');

      assert.doesNotThrow(() => {
        logger.info('circular payload', circular);
        logger.error('bigint payload', 1n);
      });

      assert.strictEqual(errorCalls.length, 2);
      assert.match(String(errorCalls[0]?.[0] ?? ''), /circular payload/);
      assert.match(String(errorCalls[1]?.[0] ?? ''), /bigint payload/);
    } finally {
      console.error = originalError;
      Logger.setLogLevel(LogLevel.FATAL);
    }
  });
});