/**
 * Entry point for the MCP video recognition server
 * status: active
 * phase: phase-5-tool-server-wiring
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-06
 * agent_notes: "Startup constructs exactly one RecognitionProvider from environment selection."
 * insights: "Gemini wraps the retained GeminiService in an adapter; openai-compatible manages its own HTTP. Transport and port parsing are unchanged."
 */

import { Server } from './server.js';
import { createLogger, LogLevel, Logger } from './utils/logger.js';
import { loadRecognitionProviderConfig } from './services/provider-config.js';
import { GeminiService } from './services/gemini.js';
import { GeminiRecognitionProvider } from './services/gemini-recognition-provider.js';
import { OpenAICompatibleRecognitionProvider } from './services/openai-compatible-recognition-provider.js';
import type { RecognitionProvider } from './types/provider.js';
import type { ServerConfig } from './server.js';

const log = createLogger('Main');

// Set log level from environment variable
const logLevel = ( process.env.LOG_LEVEL || LogLevel.FATAL ) as LogLevel;
Logger.setLogLevel(logLevel as LogLevel);

/**
 * Load configuration from environment variables
 */
async function loadConfig(): Promise<ServerConfig> {
  // Load the selected provider configuration
  const providerConfig = await loadRecognitionProviderConfig(process.env);

  // Construct the selected provider
  let provider: RecognitionProvider;
  if (providerConfig.provider === 'gemini') {
    const service = new GeminiService({ apiKey: providerConfig.apiKey });
    provider = new GeminiRecognitionProvider(service, providerConfig);
  } else {
    provider = new OpenAICompatibleRecognitionProvider(providerConfig);
  }

  // Determine transport type
  const transportType = process.env.TRANSPORT_TYPE === 'sse' ? 'sse' : 'stdio';

  // Parse port if provided
  const portStr = process.env.PORT;
  const port = portStr ? parseInt(portStr, 10) : undefined;

  return {
    provider,
    transport: transportType,
    port
  };
}

/**
 * Main function to start the server
 */
async function main(): Promise<void> {
  try {
    log.info('Starting MCP video recognition server');

    // Load configuration
    const config = await loadConfig();
    log.info(`Using provider: ${config.provider.constructor.name}`);
    log.info(`Using transport: ${config.transport}`);
    
    // Create and start server
    const server = new Server(config);
    await server.start();
    
    // Handle process termination
    process.on('SIGINT', async () => {
      log.info('Received SIGINT signal, shutting down...');
      await server.stop();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      log.info('Received SIGTERM signal, shutting down...');
      await server.stop();
      process.exit(0);
    });
    
    log.info('Server started successfully');
  } catch (error) {
    log.error('Failed to start server', error);
    process.exit(1);
  }
}

// Start the server
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
