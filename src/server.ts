/**
 * MCP server implementation
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import type { Server as HttpServer } from 'node:http';
import type { Request, Response } from 'express';
import { createLogger } from './utils/logger.js';
import { createRecognitionProvider } from './services/recognition-providers.js';
import { ParallelDispatcher } from './services/parallel-dispatcher.js';
import { createImageRecognitionTool } from './tools/image-recognition.js';
import { createAudioRecognitionTool } from './tools/audio-recognition.js';
import { createVideoRecognitionTool } from './tools/video-recognition.js';
import type { RecognitionProvider, ResolvedRecognitionConfig } from './types/index.js';

const log = createLogger('Server');
const DEFAULT_HTTP_SESSION_LIMIT = 100;

interface HttpSession {
  mcpServer: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
}

export interface ServerConfig {
  recognition: ResolvedRecognitionConfig;
  transport: 'stdio' | 'sse';
  port?: number;
  host?: string;
  authToken?: string;
  maxHttpSessions?: number;
}

export class Server {
  private readonly mcpServer: McpServer;
  private readonly recognitionProvider: RecognitionProvider;
  private readonly config: ServerConfig;
  private readonly httpSessions = new Map<string, HttpSession>();
  private readonly pendingHttpSessions = new Set<HttpSession>();
  private httpServer?: HttpServer;
  private stopPromise?: Promise<void>;

  constructor(config: ServerConfig) {
    this.config = config;
    
    // Initialize selected recognition provider
    this.recognitionProvider = createRecognitionProvider(config.recognition);
    
    // Create MCP server for stdio transport. Streamable HTTP sessions use
    // one MCP server instance per transport because the SDK Protocol owns a
    // single transport connection at a time.
    this.mcpServer = this.createMcpServer();
    
    log.info('MCP server initialized');
  }

  /**
   * Create a configured MCP server instance.
   */
  private createMcpServer(): McpServer {
    const mcpServer = new McpServer({
      name: 'media-processing',
      version: '1.0.0'
    });

    this.registerTools(mcpServer);

    return mcpServer;
  }

  /**
   * Register all tools with the MCP server
   */
  private registerTools(mcpServer: McpServer): void {
    // Create tools
    const parallelConfig = this.config.recognition.parallelInference;
    const parallelDispatcher = new ParallelDispatcher(parallelConfig);
    const imageRecognitionTool = createImageRecognitionTool(this.recognitionProvider, parallelConfig, parallelDispatcher);
    const audioRecognitionTool = createAudioRecognitionTool(this.recognitionProvider, parallelConfig, parallelDispatcher);
    const videoRecognitionTool = createVideoRecognitionTool(this.recognitionProvider, parallelConfig, parallelDispatcher);
    
    // Register tools with MCP server
    mcpServer.registerTool(
      imageRecognitionTool.name,
      {
        title: imageRecognitionTool.title,
        description: imageRecognitionTool.description,
        inputSchema: imageRecognitionTool.inputSchema,
        annotations: imageRecognitionTool.annotations
      },
      imageRecognitionTool.callback
    );
    
    mcpServer.registerTool(
      audioRecognitionTool.name,
      {
        title: audioRecognitionTool.title,
        description: audioRecognitionTool.description,
        inputSchema: audioRecognitionTool.inputSchema,
        annotations: audioRecognitionTool.annotations
      },
      audioRecognitionTool.callback
    );
    
    mcpServer.registerTool(
      videoRecognitionTool.name,
      {
        title: videoRecognitionTool.title,
        description: videoRecognitionTool.description,
        inputSchema: videoRecognitionTool.inputSchema,
        annotations: videoRecognitionTool.annotations
      },
      videoRecognitionTool.callback
    );
    
    log.info('All tools registered with MCP server');
  }

  /**
   * Start the server with the configured transport
   */
  async start(): Promise<void> {
    try {
      if (this.config.transport === 'stdio') {
        await this.startWithStdio();
      } else if (this.config.transport === 'sse') {
        await this.startWithSSE();
      } else {
        throw new Error(`Unsupported transport: ${this.config.transport}`);
      }
    } catch (error) {
      log.error('Failed to start server', error);
      throw error;
    }
  }

  /**
   * Start the server with stdio transport
   */
  private async startWithStdio(): Promise<void> {
    log.info('Starting server with stdio transport');
    
    const transport = new StdioServerTransport();
    
    transport.onclose = () => {
      log.info('Stdio transport closed');
    };
    
    transport.onerror = (error) => {
      log.error('Stdio transport error', error);
    };
    
    await this.mcpServer.connect(transport);
    log.info('Server started with stdio transport');
  }

  /**
   * Start the server with SSE transport
   */
  private async startWithSSE(): Promise<void> {
    log.info('Starting server with SSE transport');
    
    // Import express dynamically to avoid loading it when using stdio
    const express = await import('express');
    const app = express.default();
    const port = this.config.port ?? 3000;
    const host = this.config.host ?? '127.0.0.1';
    
    app.use(express.json());

    app.use('/mcp', (req, res, next) => {
      if (!this.isHttpAuthRequired()) {
        next();
        return;
      }

      if (this.isAuthorizedRequest(req)) {
        next();
        return;
      }

      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Unauthorized'
        },
        id: null
      });
    });
    
    // Handle POST requests for client-to-server communication
    app.post('/mcp', async (req, res) => {
      await this.handleHttpPost(req, res);
    });
    
    // Handle GET requests for server-to-client notifications via SSE
    app.get('/mcp', async (req, res) => {
      await this.handleHttpSessionRequest(req, res);
    });
    
    // Handle DELETE requests for session termination
    app.delete('/mcp', async (req, res) => {
      await this.handleHttpSessionRequest(req, res);
    });
    
    // Start the HTTP server
    await new Promise<void>((resolve, reject) => {
      const httpServer = app.listen(port, host, () => {
        httpServer.off('error', reject);
        log.info(`Server started with SSE transport on port ${this.getHttpPort() ?? port}`);
        resolve();
      });

      this.httpServer = httpServer;
      httpServer.once('error', reject);
    });
  }

  /**
   * Return the bound HTTP address, if the HTTP listener is running.
   */
  getHttpAddress(): ReturnType<HttpServer['address']> | undefined {
    return this.httpServer?.address();
  }

  /**
   * Return the bound HTTP port, useful when the server was started with port 0.
   */
  getHttpPort(): number | undefined {
    const address = this.getHttpAddress();
    if (typeof address === 'object' && address !== null) {
      return address.port;
    }

    return undefined;
  }

  /**
   * Handle Streamable HTTP POST requests.
   */
  private async handleHttpPost(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = this.getHttpSessionId(req);
      const existingSession = sessionId ? this.httpSessions.get(sessionId) : undefined;

      if (existingSession) {
        existingSession.lastSeenAt = Date.now();
        log.debug(`Using existing transport for session: ${sessionId}`);
        await existingSession.transport.handleRequest(req, res, req.body);
        return;
      }

      if (sessionId) {
        this.writeJsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }

      if (!isInitializeRequest(req.body)) {
        this.writeJsonRpcError(res, 400, -32000, 'Bad Request: Session ID required');
        return;
      }

      if (this.getHttpSessionCount() >= this.getHttpSessionLimit()) {
        this.writeJsonRpcError(res, 503, -32000, 'Too many active HTTP sessions');
        return;
      }

      const session = this.createHttpSession();
      try {
        await session.mcpServer.connect(session.transport);
        await session.transport.handleRequest(req, res, req.body);
      } finally {
        if (this.pendingHttpSessions.has(session)) {
          await this.closeHttpSession(session);
        }
      }
    } catch (error) {
      log.error('Error handling MCP request', error);
      if (!res.headersSent) {
        this.writeJsonRpcError(res, 500, -32603, 'Internal server error');
      }
    }
  }

  /**
   * Handle Streamable HTTP GET and DELETE requests that require an existing session.
   */
  private async handleHttpSessionRequest(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = this.getHttpSessionId(req);
      const session = sessionId ? this.httpSessions.get(sessionId) : undefined;

      if (session) {
        session.lastSeenAt = Date.now();
        await session.transport.handleRequest(req, res);
        return;
      }

      if (sessionId) {
        this.writeJsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }

      this.writeJsonRpcError(res, 400, -32000, 'Bad Request: Session ID required');
    } catch (error) {
      log.error('Error handling MCP session request', error);
      if (!res.headersSent) {
        this.writeJsonRpcError(res, 500, -32603, 'Internal server error');
      }
    }
  }

  /**
   * Create a new stateful HTTP session transport and MCP server pair.
   */
  private createHttpSession(): HttpSession {
    const mcpServer = this.createMcpServer();
    const sessionRef: { current?: HttpSession } = {};
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        const session = sessionRef.current;
        if (!session) {
          throw new Error('HTTP session initialized before transport was registered');
        }

        session.lastSeenAt = Date.now();
        this.pendingHttpSessions.delete(session);
        this.httpSessions.set(sessionId, session);
        log.info(`New session initialized: ${sessionId}`);
      }
    });

    const session = {
      mcpServer,
      transport,
      lastSeenAt: Date.now()
    };
    sessionRef.current = session;

    transport.onclose = () => {
      const sessionId = transport.sessionId;
      this.pendingHttpSessions.delete(session);
      if (sessionId && this.httpSessions.get(sessionId)?.transport === transport) {
        this.httpSessions.delete(sessionId);
        log.info(`Session closed: ${sessionId}`);
      }
    };

    transport.onerror = (error) => {
      log.error('HTTP transport error', error);
    };

    this.pendingHttpSessions.add(session);

    return session;
  }

  /**
   * Extract the MCP session ID header from an Express request.
   */
  private getHttpSessionId(req: Request): string | undefined {
    const sessionId = req.headers['mcp-session-id'];

    if (Array.isArray(sessionId)) {
      return sessionId[0];
    }

    return sessionId;
  }

  /**
   * Return whether HTTP authentication is enabled.
   */
  private isHttpAuthRequired(): boolean {
    return this.config.authToken !== undefined;
  }

  /**
   * Return whether the request has a valid bearer token.
   */
  private isAuthorizedRequest(req: Request): boolean {
    const expectedToken = this.config.authToken;

    if (expectedToken === undefined) {
      return true;
    }

    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string') {
      return false;
    }

    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return false;
    }

    return match[1] === expectedToken;
  }

  /**
   * Write a JSON-RPC error with the supplied HTTP status.
   */
  private writeJsonRpcError(res: Response, status: number, code: number, message: string): void {
    res.status(status).json({
      jsonrpc: '2.0',
      error: {
        code,
        message,
      },
      id: null,
    });
  }

  /**
   * Return the active HTTP session limit.
   */
  private getHttpSessionLimit(): number {
    return this.config.maxHttpSessions ?? DEFAULT_HTTP_SESSION_LIMIT;
  }

  /**
   * Return all HTTP sessions that currently consume lifecycle capacity.
   */
  private getHttpSessionCount(): number {
    return this.httpSessions.size + this.pendingHttpSessions.size;
  }

  /**
   * Close the HTTP listener if it is running.
   */
  private async closeHttpServer(): Promise<void> {
    const httpServer = this.httpServer;
    this.httpServer = undefined;

    if (!httpServer || !httpServer.listening) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      httpServer.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  /**
   * Close all active HTTP session transports via their owning MCP servers.
   */
  private async closeHttpSessions(): Promise<void> {
    const sessions = new Set([
      ...this.httpSessions.values(),
      ...this.pendingHttpSessions.values()
    ]);
    await Promise.all(Array.from(sessions).map(async (session) => {
      await this.closeHttpSession(session);
    }));
    this.httpSessions.clear();
    this.pendingHttpSessions.clear();
  }

  /**
   * Close a single HTTP session and remove it from lifecycle tracking.
   */
  private async closeHttpSession(session: HttpSession): Promise<void> {
    this.pendingHttpSessions.delete(session);
    const sessionId = session.transport.sessionId;
    if (sessionId && this.httpSessions.get(sessionId) === session) {
      this.httpSessions.delete(sessionId);
    }

    await session.mcpServer.close();
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = this.stopOnce();
    return this.stopPromise;
  }

  /**
   * Stop the server exactly once.
   */
  private async stopOnce(): Promise<void> {
    try {
      await this.closeHttpServer();
      await this.closeHttpSessions();
      await this.mcpServer.close();
      log.info('Server stopped');
    } catch (error) {
      log.error('Error stopping server', error);
      throw error;
    }
  }
}
