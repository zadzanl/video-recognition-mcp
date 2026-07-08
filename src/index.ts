/**
 * Entry point for the MCP video recognition server
 */

import { Server } from './server.js';
import { createLogger, LogLevel, Logger } from './utils/logger.js';
import type { ServerConfig } from './server.js';
import { loadRecognitionConfig } from './services/provider-config.js';

const log = createLogger('Main');

// Set log level from environment variable
const logLevel = ( process.env.LOG_LEVEL || LogLevel.FATAL ) as LogLevel;
Logger.setLogLevel(logLevel as LogLevel);

/**
 * Load configuration from environment variables
 */
function loadConfig(): ServerConfig {
  // Determine transport type
  const transportType = process.env.TRANSPORT_TYPE === 'sse' ? 'sse' : 'stdio';
  
  // Parse port if provided
  const portStr = process.env.PORT;
  const port = portStr ? parseInt(portStr, 10) : undefined;
  const host = normalizeEnvValue(process.env.HOST) ?? '127.0.0.1';
  const authToken = normalizeEnvValue(process.env.MCP_AUTH_TOKEN);
  
  return {
    recognition: loadRecognitionConfig(),
    transport: transportType,
    port,
    host,
    authToken
  };
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Main function to start the server
 */
async function main(): Promise<void> {
  try {
    log.info('Starting MCP video recognition server');
    
    // Load configuration
    const config = loadConfig();
    log.info(`Using transport: ${config.transport}`);
    
    // Create and start server
    const server = new Server(config);
    await server.start();
    
    // Handle process termination
    let shutdownInProgress = false;
    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      if (shutdownInProgress) {
        log.info(`Received ${signal} signal while shutdown is already in progress`);
        return;
      }

      shutdownInProgress = true;
      log.info(`Received ${signal} signal, shutting down...`);

      try {
        await server.stop();
        process.exit(0);
      } catch (error) {
        log.error('Error during shutdown', error);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => {
      void shutdown('SIGINT');
    });
    
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM');
    });
    
    log.info('Server started successfully');
  } catch (error) {
    log.error('Failed to start server', error);
    process.exit(1);
  }
}

// Start the server
main().catch(error => {
  log.fatal('Unhandled error', error);
  process.exit(1);
});
