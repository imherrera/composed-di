import { describe, it, expect, beforeEach } from 'vitest';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';
import { ServiceFactory, ServiceKey, ServiceModule } from '@composed-di/core';
import {
  OtelEventListener,
  OtelEventListenerOptions,
} from '../src/otelEventListener';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
});

const makeListener = (options: OtelEventListenerOptions = {}) =>
  new OtelEventListener({ tracer: provider.getTracer('test'), ...options });

const spans = () => exporter.getFinishedSpans();
const byName = (name: string) => {
  const span = spans().find((s) => s.name === name);
  expect(span, `expected a span named ${name}`).toBeDefined();
  return span!;
};
const spanIdOf = (span: ReadableSpan) => span.spanContext().spanId;
const parentIdOf = (span: ReadableSpan) =>
  span.parentSpanContext?.spanId ??
  (span as unknown as { parentSpanId?: string }).parentSpanId;

describe('OtelEventListener', () => {
  it('should record initialize and method call spans with attributes', async () => {
    const Key = new ServiceKey<{ greet(): string }>('svc');
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({ greet: () => 'hi' }),
    });
    const module = ServiceModule.from([factory], makeListener());

    const svc = await module.get(Key);
    svc.greet();

    const init = byName('svc.initialize');
    expect(init.attributes).toMatchObject({
      'composed_di.service': 'svc',
      'composed_di.method': 'initialize',
      'composed_di.operation': 'initialize',
    });
    const call = byName('svc.greet');
    expect(call.attributes).toMatchObject({
      'composed_di.service': 'svc',
      'composed_di.method': 'greet',
      'composed_di.operation': 'call',
    });
  });

  it('should record dispose spans', async () => {
    const Key = new ServiceKey<{ x: number }>('svc');
    const factory: ServiceFactory<{ x: number }, []> = {
      provides: Key,
      dependsOn: [],
      scope: undefined,
      initialize: () => ({ x: 1 }),
      dispose: () => {},
    };
    const module = ServiceModule.from([factory], makeListener());

    await module.get(Key);
    module.dispose();
    expect(byName('svc.dispose').attributes).toMatchObject({
      'composed_di.operation': 'dispose',
    });
  });

  it('should parent nested service calls across async boundaries', async () => {
    const DbKey = new ServiceKey<{ query(sql: string): Promise<string> }>(
      'Database',
    );
    const UserKey = new ServiceKey<{ getUser(id: number): Promise<string> }>(
      'UserService',
    );
    const db = ServiceFactory.singleton({
      provides: DbKey,
      initialize: () => ({ query: async (sql: string) => `row:${sql}` }),
    });
    const users = ServiceFactory.singleton({
      provides: UserKey,
      dependsOn: [DbKey],
      initialize: (database) => ({
        getUser: (id: number) => database.query(`u${id}`),
      }),
    });
    const module = ServiceModule.from([db, users], makeListener());

    const svc = await module.get(UserKey);
    await svc.getUser(7);

    const getUser = byName('UserService.getUser');
    const query = byName('Database.query');
    expect(parentIdOf(query)).toBe(spanIdOf(getUser));
    expect(query.spanContext().traceId).toBe(getUser.spanContext().traceId);
  });

  it('should mark failed operations with ERROR status and the exception', async () => {
    const Key = new ServiceKey<{ boom(): never }>('svc');
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({
        boom: () => {
          throw new Error('kaput');
        },
      }),
    });
    const module = ServiceModule.from([factory], makeListener());

    const svc = await module.get(Key);
    expect(() => svc.boom()).toThrow('kaput');

    const span = byName('svc.boom');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('kaput');
    expect(span.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('should end async method spans when the promise settles', async () => {
    const Key = new ServiceKey<{ fail(): Promise<never> }>('svc');
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({
        fail: async () => {
          throw new Error('async kaput');
        },
      }),
    });
    const module = ServiceModule.from([factory], makeListener());

    const svc = await module.get(Key);
    await expect(svc.fail()).rejects.toThrow('async kaput');
    expect(byName('svc.fail').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('should not capture arguments or results by default', async () => {
    const Key = new ServiceKey<{ add(a: number, b: number): number }>('svc');
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({ add: (a: number, b: number) => a + b }),
    });
    const module = ServiceModule.from([factory], makeListener());

    const svc = await module.get(Key);
    svc.add(2, 3);
    const span = byName('svc.add');
    expect(span.attributes['composed_di.args']).toBeUndefined();
    expect(span.attributes['composed_di.result']).toBeUndefined();
  });

  it('should capture arguments and results when opted in', async () => {
    const Key = new ServiceKey<{ add(a: number, b: number): number }>('svc');
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({ add: (a: number, b: number) => a + b }),
    });
    const module = ServiceModule.from(
      [factory],
      makeListener({ captureArguments: true, captureResults: true }),
    );

    const svc = await module.get(Key);
    svc.add(2, 3);
    const span = byName('svc.add');
    expect(span.attributes['composed_di.args']).toBe('[2,3]');
    expect(span.attributes['composed_di.result']).toBe('5');
  });

  it('should truncate captured values beyond maxCaptureLength', async () => {
    const Key = new ServiceKey<{ echo(s: string): string }>('svc');
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({ echo: (s: string) => s }),
    });
    const module = ServiceModule.from(
      [factory],
      makeListener({ captureArguments: true, maxCaptureLength: 10 }),
    );

    const svc = await module.get(Key);
    svc.echo('x'.repeat(100));
    const args = byName('svc.echo').attributes['composed_di.args'] as string;
    expect(args).toHaveLength(11); // 10 chars + ellipsis
    expect(args.endsWith('…')).toBe(true);
  });
});
