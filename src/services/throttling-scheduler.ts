/**
 * Throttling Scheduler Queue (Auto Recovery)
 */

import { RateLimitTracker } from './rate-limit-tracker.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ThrottlingScheduler');

export class ThrottlingScheduler {
  constructor(private readonly tracker: RateLimitTracker) {}

  /**
   * Schedule a request by waiting until a model in the fallback chain is available.
   * Returns the selected model name when one is available.
   * Throws a timeout error if maxWaitMs is exceeded.
   */
  public async scheduleRequest(
    candidateModels: string[],
    mediaKind: 'image' | 'audio' | 'video',
    maxWaitMs = 30000
  ): Promise<string> {
    const startTime = Date.now();
    const tokenEstimate = this.estimateTokens(mediaKind);

    log.debug(`Scheduling request for ${mediaKind} recognition with candidates: ${candidateModels.join(', ')}`);

    while (true) {
      // Find the first available model
      for (const model of candidateModels) {
        if (this.tracker.isModelAvailable(model, tokenEstimate)) {
          // Record the attempt immediately (proactive booking)
          this.tracker.recordAttempt(model, tokenEstimate);
          log.info(`Scheduled request on model: ${model} (token estimate: ${tokenEstimate})`);
          return model;
        }
      }

      // If we exceeded maxWaitMs, throw timeout
      if (Date.now() - startTime > maxWaitMs) {
        const errMsg = `Scheduling timeout: all models are currently rate-limited or cooling down after waiting ${maxWaitMs}ms.`;
        log.error(errMsg);
        throw new Error(errMsg);
      }

      // Sleep 500ms before retrying
      log.verbose('All models rate-limited, sleeping 500ms...');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  /**
   * Conservative estimation of tokens used by a request
   */
  private estimateTokens(mediaKind: 'image' | 'audio' | 'video'): number {
    switch (mediaKind) {
      case 'image': return 1000;
      case 'audio': return 2000;
      case 'video': return 10000;
      default: return 1000;
    }
  }
}
