/**
 * Persistent file-backed Rate Limit Tracker
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLogger } from '../utils/logger.js';

const log = createLogger('RateLimitTracker');

export interface ThrottlingRule {
  Short_limit_duration_in_seconds: number;
  Long_limit_duration_in_seconds: number;
  Short_limit_request_cap: number;
  Long_limit_request_cap: number;
  Short_limit_token_cap: number;
  Long_limit_token_cap: number;
}

export interface ThrottlingLimitsConfig {
  models: Record<string, ThrottlingRule>;
}

export interface RequestEntry {
  timestamp: number;
  tokens: number;
}

export interface ModelRateState {
  shortRequestTimestamps: RequestEntry[];
  longRequestTimestamps: RequestEntry[];
  cooldownUntil: number;
}

export interface RateLimitTrackerState {
  models: Record<string, ModelRateState>;
}

type ParsedRecord = Record<string, unknown>;

function isRecordLike(value: unknown): value is ParsedRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createNullPrototypeRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function normalizeOwnStringKeys<T>(record: ParsedRecord): Record<string, T> {
  const normalized = createNullPrototypeRecord<T>();
  for (const key of Object.keys(record)) {
    normalized[key] = record[key] as T;
  }
  return normalized;
}

const DEFAULT_RULE: ThrottlingRule = {
  Short_limit_duration_in_seconds: 60,
  Long_limit_duration_in_seconds: 86400,
  Short_limit_request_cap: 5,
  Long_limit_request_cap: 20,
  Short_limit_token_cap: 100000,
  Long_limit_token_cap: 500000
};

export class RateLimitTracker {
  private readonly stateFilePath: string;
  private readonly limitsFilePath: string;
  private readonly warnedModels = new Set<string>();
  private limits: ThrottlingLimitsConfig = { models: createNullPrototypeRecord<ThrottlingRule>() };

  constructor(customLimitsPath?: string) {
    const envPath = process.env.RATE_LIMIT_TRACKER_PATH;
    this.stateFilePath = envPath ? envPath : path.join(os.tmpdir(), 'mcp-video-recognition-rate-limits.json');
    this.limitsFilePath = customLimitsPath ?? path.join(process.cwd(), 'config', 'throttling-limits.json');
    this.loadLimits();
  }

  /**
   * Load human-editable throttling limits configuration
   */
  private loadLimits(): void {
    try {
      if (fs.existsSync(this.limitsFilePath)) {
        const raw = fs.readFileSync(this.limitsFilePath, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (isRecordLike(parsed) && Object.hasOwn(parsed, 'models') && isRecordLike(parsed.models)) {
          this.limits = { models: normalizeOwnStringKeys<ThrottlingRule>(parsed.models) };
          log.info(`Loaded throttling limits config from ${this.limitsFilePath}`);
          return;
        }
      }
    } catch (error) {
      log.warn(`Failed to parse throttling limits file: ${error instanceof Error ? error.message : String(error)}. Using defaults.`);
    }
    log.info('Using default hardcoded throttling limits');
  }

  /**
   * Get limits configuration for a model
   */
  public getLimitsForModel(modelName: string): ThrottlingRule {
    const configuredRule = Object.hasOwn(this.limits.models, modelName)
      ? this.limits.models[modelName]
      : undefined;
    if (configuredRule) {
      return configuredRule;
    }
    
    if (!this.warnedModels.has(modelName)) {
      this.warnedModels.add(modelName);
      log.warn(`No throttle config entry for model "${modelName}". Using DEFAULT_RULE.`);
    }

    return DEFAULT_RULE;
  }

  /**
   * Read the persistent tracker state from temp file
   */
  public readState(): RateLimitTrackerState {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (isRecordLike(parsed) && Object.hasOwn(parsed, 'models') && isRecordLike(parsed.models)) {
          return { models: normalizeOwnStringKeys<ModelRateState>(parsed.models) };
        }
      }
    } catch (error) {
      log.warn(`Error reading rate-limit tracker state file, resetting state: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { models: createNullPrototypeRecord<ModelRateState>() };
  }

  /**
   * Write tracker state atomically
   */
  private writeState(state: RateLimitTrackerState): void {
    const tempPath = `${this.stateFilePath}.tmp`;
    try {
      // Ensure temp directory exists
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tempPath, this.stateFilePath);
    } catch (error) {
      log.error(`Failed to write rate-limit state file: ${error instanceof Error ? error.message : String(error)}`);
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {}
    }
  }

  /**
   * Check if a model is currently available (not rate-limited or in cooldown)
   */
  public isModelAvailable(modelName: string, tokensInRequest = 0): boolean {
    const state = this.readState();
    const modelState = Object.hasOwn(state.models, modelName)
      ? state.models[modelName]
      : undefined;
    if (!modelState) {
      return true;
    }

    const now = Date.now();

    // Check cooldown
    if (modelState.cooldownUntil && modelState.cooldownUntil > now) {
      log.debug(`Model ${modelName} is in active cooldown until ${modelState.cooldownUntil}`);
      return false;
    }

    const rule = this.getLimitsForModel(modelName);

    // Clean up expired entries and check short limit
    const shortLimitCutoff = now - rule.Short_limit_duration_in_seconds * 1000;
    const activeShortEntries = (modelState.shortRequestTimestamps || [])
      .filter(e => e.timestamp > shortLimitCutoff);

    if (activeShortEntries.length >= rule.Short_limit_request_cap) {
      log.debug(`Model ${modelName} hit short request limit: ${activeShortEntries.length}/${rule.Short_limit_request_cap}`);
      return false;
    }

    const shortTokenSum = activeShortEntries.reduce((sum, e) => sum + e.tokens, 0);
    if (shortTokenSum + tokensInRequest > rule.Short_limit_token_cap) {
      log.debug(`Model ${modelName} hit short token limit: ${shortTokenSum + tokensInRequest}/${rule.Short_limit_token_cap}`);
      return false;
    }

    // Clean up expired entries and check long limit
    const longLimitCutoff = now - rule.Long_limit_duration_in_seconds * 1000;
    const activeLongEntries = (modelState.longRequestTimestamps || [])
      .filter(e => e.timestamp > longLimitCutoff);

    if (activeLongEntries.length >= rule.Long_limit_request_cap) {
      log.debug(`Model ${modelName} hit long request limit: ${activeLongEntries.length}/${rule.Long_limit_request_cap}`);
      return false;
    }

    const longTokenSum = activeLongEntries.reduce((sum, e) => sum + e.tokens, 0);
    if (longTokenSum + tokensInRequest > rule.Long_limit_token_cap) {
      log.debug(`Model ${modelName} hit long token limit: ${longTokenSum + tokensInRequest}/${rule.Long_limit_token_cap}`);
      return false;
    }

    return true;
  }

  /**
   * Record a request attempt in the tracker
   */
  public recordAttempt(modelName: string, tokensInRequest = 0): void {
    const state = this.readState();
    let modelState = Object.hasOwn(state.models, modelName)
      ? state.models[modelName]
      : undefined;
    if (!modelState) {
      modelState = {
        shortRequestTimestamps: [],
        longRequestTimestamps: [],
        cooldownUntil: 0
      };
      state.models[modelName] = modelState;
    }

    const now = Date.now();
    const entry: RequestEntry = { timestamp: now, tokens: tokensInRequest };

    modelState.shortRequestTimestamps = (modelState.shortRequestTimestamps || [])
      .filter(e => e.timestamp > now - this.getLimitsForModel(modelName).Short_limit_duration_in_seconds * 1000);
    modelState.shortRequestTimestamps.push(entry);

    modelState.longRequestTimestamps = (modelState.longRequestTimestamps || [])
      .filter(e => e.timestamp > now - this.getLimitsForModel(modelName).Long_limit_duration_in_seconds * 1000);
    modelState.longRequestTimestamps.push(entry);

    this.writeState(state);
    log.debug(`Recorded attempt on model ${modelName} with ${tokensInRequest} tokens`);
  }

  /**
   * Mark a model as in cooldown (cooling down after a rate limit failure)
   */
  public markCooldown(modelName: string, durationMs = 60000): void {
    const state = this.readState();
    let modelState = Object.hasOwn(state.models, modelName)
      ? state.models[modelName]
      : undefined;
    if (!modelState) {
      modelState = {
        shortRequestTimestamps: [],
        longRequestTimestamps: [],
        cooldownUntil: 0
      };
      state.models[modelName] = modelState;
    }

    modelState.cooldownUntil = Date.now() + durationMs;
    this.writeState(state);
    log.warn(`Model ${modelName} marked in cooldown for ${durationMs}ms`);
  }

  /**
   * Clear cooldown for a model (for testing/recovery)
   */
  public clearCooldown(modelName: string): void {
    const state = this.readState();
    if (Object.hasOwn(state.models, modelName)) {
      const modelState = state.models[modelName];
      if (!modelState) {
        return;
      }

      modelState.cooldownUntil = 0;
      this.writeState(state);
      log.info(`Cleared cooldown for model ${modelName}`);
    }
  }

  /**
   * Clear all tracker states (used for testing and resets)
   */
  public clearAll(): void {
    this.writeState({ models: createNullPrototypeRecord<ModelRateState>() });
    log.info('Cleared all rate-limit tracker states');
  }
}
