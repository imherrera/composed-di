import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';
import { ServiceModule } from '@composed-di/core';
import {
  DashboardInstrumentation,
  DashboardInstrumentationOptions,
} from './dashboardInstrumentation';
import { ModuleGraph, moduleGraph } from './moduleGraph';
import { renderDashboardHtml } from './dashboardHtml';
import {
  DashboardSnapshot,
  GraphEdge,
  GraphNode,
  ServiceStats,
  SpanEvent,
  SpanKind,
  SpanStart,
  WireEvent,
} from './events';

export interface ServiceDashboardOptions extends DashboardInstrumentationOptions {
  /** How many recent events to keep for late-joining clients. Default 200. */
  recentEventLimit?: number;
}

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * A realtime dashboard server for observed ServiceModules.
 *
 * Serves a self-contained HTML page that renders the dependency graph and
 * streams service initialization, disposal, and method-call activity to it
 * over Server-Sent Events. Uses only Node.js built-ins.
 *
 * Two ways to feed it, mirroring how OpenTelemetry separates SDK and
 * collector:
 *
 * **Standalone (recommended):** run the server on its own — `npx
 * composed-di-dashboard` or `new ServiceDashboard().listen(4321)` — and have
 * the application export to it with a {@link DashboardClient}. The server
 * accepts `POST /v1/graph` (the dependency graph) and `POST /v1/events`
 * (batched span events).
 *
 * **In-process:** create the module with `dashboard.instrumentation`, call
 * `dashboard.attach(module)`, and `listen` from the same process.
 *
 * @example
 * ```ts
 * // dashboard process
 * const dashboard = new ServiceDashboard();
 * await dashboard.listen(4321);
 *
 * // application process
 * const client = new DashboardClient({ url: 'http://localhost:4321' });
 * const module = ServiceModule.from(instrument(factories, client.instrumentation));
 * client.attach(module);
 * ```
 */
export class ServiceDashboard {
  /** Pass this to `instrument()` when composing the module. */
  readonly instrumentation: DashboardInstrumentation;

  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private services = new Map<string, ServiceStats>();
  /** Open spans, so end events can be resolved to their start metadata. */
  private openSpans = new Map<number, SpanStart>();
  private recent: WireEvent[] = [];
  private readonly recentEventLimit: number;
  /** Whether any graph was registered; ingest is refused (409) before that. */
  private graphRegistered = false;

  private clients = new Set<ServerResponse>();
  private server: Server | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor({
    recentEventLimit = 200,
    ...instrumentationOptions
  }: ServiceDashboardOptions = {}) {
    this.instrumentation = new DashboardInstrumentation(instrumentationOptions);
    this.recentEventLimit = recentEventLimit;
    this.instrumentation.subscribe((event) => this.onSpanEvent(event));
  }

  /**
   * In-process mode: reads the dependency graph out of the module. Call
   * this with the module that was created with this dashboard's instrumentation.
   */
  attach(module: ServiceModule): this {
    this.registerGraph(moduleGraph(module));
    return this;
  }

  /**
   * Registers a dependency graph, resetting all aggregated state (a new
   * registration means a new application run). Remote applications call this
   * through `POST /v1/graph`.
   */
  registerGraph(graph: ModuleGraph): void {
    this.graphRegistered = true;
    this.nodes = graph.nodes;
    this.edges = graph.edges;
    this.services = new Map(
      this.nodes.map((node) => [node.name, freshStats()]),
    );
    this.openSpans.clear();
    this.recent = [];
    this.broadcastSnapshot();
  }

  /**
   * Applies span events, e.g. exported by a remote DashboardClient through
   * `POST /v1/events`. Services not present in the registered graph are
   * added as standalone nodes rather than dropped.
   */
  ingest(events: SpanEvent[]): void {
    for (const event of events) {
      if (
        event.type === 'start' &&
        event.service !== null &&
        !this.services.has(event.service)
      ) {
        this.nodes.push({ name: event.service });
        this.services.set(event.service, freshStats());
        this.broadcastSnapshot();
      }
      this.onSpanEvent(event);
    }
  }

  /** The current full dashboard state, as sent to newly connected clients. */
  snapshot(): DashboardSnapshot {
    return {
      nodes: this.nodes,
      edges: this.edges,
      services: Object.fromEntries(this.services),
      recent: this.recent,
    };
  }

  /**
   * Starts the HTTP server.
   *
   * @param port The port to listen on; 0 picks a free port. Default 4321.
   * @param host The host to bind. Default 127.0.0.1.
   * @returns The URL the dashboard is reachable at.
   */
  listen(port = 4321, host = '127.0.0.1'): Promise<string> {
    if (this.server) {
      throw new Error('Dashboard server is already listening');
    }
    const server = createServer((request, response) => {
      void this.route(request, response);
    });
    this.server = server;
    this.heartbeat = setInterval(() => {
      this.clients.forEach((client) => client.write(': ping\n\n'));
    }, HEARTBEAT_INTERVAL_MS);
    // Don't let an idle dashboard keep the process alive on its own.
    this.heartbeat.unref();

    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        const address = server.address() as AddressInfo;
        const shownHost =
          host === '0.0.0.0' || host === '::' ? 'localhost' : host;
        resolve(`http://${shownHost}:${address.port}`);
      });
    });
  }

  /** Stops the server and disconnects all clients. */
  async close(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.clients.forEach((client) => client.end());
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const path = request.url?.split('?')[0];
    const route = `${request.method} ${path}`;
    try {
      switch (route) {
        case 'GET /':
          response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
          });
          response.end(renderDashboardHtml());
          return;
        case 'GET /events':
          this.acceptEventStream(response);
          return;
        case 'GET /snapshot':
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(this.snapshot()));
          return;
        case 'POST /v1/graph': {
          const graph = await readJsonBody(request);
          if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
            throw new BadRequestError('expected { nodes: [], edges: [] }');
          }
          this.registerGraph(graph);
          response.writeHead(204);
          response.end();
          return;
        }
        case 'POST /v1/events': {
          const body = await readJsonBody(request);
          if (!Array.isArray(body?.events)) {
            throw new BadRequestError('expected { events: [] }');
          }
          // A restarted server has no graph; tell the client to re-register
          // before it sends events, so context isn't rendered nodeless.
          if (!this.graphRegistered) {
            response.writeHead(409, { 'content-type': 'text/plain' });
            response.end('no graph registered; POST /v1/graph first');
            return;
          }
          this.ingest(body.events);
          response.writeHead(204);
          response.end();
          return;
        }
        default:
          response.writeHead(404, { 'content-type': 'text/plain' });
          response.end('Not found');
      }
    } catch (error) {
      const badRequest = error instanceof BadRequestError;
      response.writeHead(badRequest ? 400 : 500, {
        'content-type': 'text/plain',
      });
      response.end(badRequest ? error.message : 'Internal error');
    }
  }

  private acceptEventStream(response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(sseMessage('snapshot', this.snapshot()));
    this.clients.add(response);
    response.on('close', () => this.clients.delete(response));
  }

  /**
   * Applies a raw span event to the aggregated per-service state and
   * broadcasts the enriched event to connected clients.
   */
  private onSpanEvent(event: SpanEvent): void {
    let wire: WireEvent;

    if (event.type === 'start') {
      this.openSpans.set(event.id, event);
      const stats = this.applyStart(event);
      wire = {
        span: event,
        service: event.service,
        method: event.method,
        kind: event.kind,
        parentService: this.parentServiceOf(event),
        args: event.args ?? null,
        // Copy so the recent-events buffer keeps at-the-time values.
        stats: stats ? copyStats(stats) : null,
      };
    } else {
      const start = this.openSpans.get(event.id);
      this.openSpans.delete(event.id);
      const stats = start ? this.applyEnd(start, event) : null;
      wire = {
        span: event,
        service: start?.service ?? null,
        method: start?.method ?? '?',
        kind: start?.kind ?? 'call',
        parentService: start ? this.parentServiceOf(start) : null,
        args: start?.args ?? null,
        stats: stats ? copyStats(stats) : null,
      };
    }

    this.recent.push(wire);
    if (this.recent.length > this.recentEventLimit) {
      this.recent.splice(0, this.recent.length - this.recentEventLimit);
    }
    const message = sseMessage('span', wire);
    this.clients.forEach((client) => client.write(message));
  }

  private applyStart(event: SpanStart): ServiceStats | null {
    const stats = event.service ? this.services.get(event.service) : undefined;
    if (!stats) return null;
    if (event.kind === 'initialize') {
      stats.status = 'initializing';
    }
    return stats;
  }

  private applyEnd(
    start: SpanStart,
    event: { durationMs: number; error: string | null },
  ): ServiceStats | null {
    const stats = start.service ? this.services.get(start.service) : undefined;
    if (!stats) return null;

    if (event.error !== null) {
      stats.errors += 1;
    }
    const transitions: Record<SpanKind, () => void> = {
      initialize: () => {
        stats.status = event.error !== null ? 'error' : 'ready';
        if (event.error === null) stats.initMs = event.durationMs;
      },
      dispose: () => {
        if (event.error === null) stats.status = 'disposed';
      },
      call: () => {
        stats.calls += 1;
        stats.totalCallMs += event.durationMs;
        const method = (stats.methods[start.method] ??= {
          calls: 0,
          errors: 0,
          totalMs: 0,
          lastMs: 0,
        });
        method.calls += 1;
        method.totalMs += event.durationMs;
        method.lastMs = event.durationMs;
        if (event.error !== null) method.errors += 1;
      },
    };
    transitions[start.kind]();
    return stats;
  }

  /** Walks to the parent span to find which service triggered this one. */
  private parentServiceOf(event: SpanStart): string | null {
    if (event.parentId === null) return null;
    return this.openSpans.get(event.parentId)?.service ?? null;
  }

  /** Pushes the full state to all connected clients, e.g. on graph changes. */
  private broadcastSnapshot(): void {
    const message = sseMessage('snapshot', this.snapshot());
    this.clients.forEach((client) => client.write(message));
  }
}

function freshStats(): ServiceStats {
  return {
    status: 'pending',
    initMs: null,
    calls: 0,
    errors: 0,
    totalCallMs: 0,
    methods: {},
  };
}

/** Deep enough that the recent-events buffer keeps at-the-time values. */
function copyStats(stats: ServiceStats): ServiceStats {
  return {
    ...stats,
    methods: Object.fromEntries(
      Object.entries(stats.methods).map(([name, method]) => [
        name,
        { ...method },
      ]),
    ),
  };
}

class BadRequestError extends Error {}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function readJsonBody(request: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BadRequestError('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new BadRequestError('invalid JSON body'));
      }
    });
    request.on('error', reject);
  });
}

function sseMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
