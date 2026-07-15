import { describe, it, expect, beforeEach } from 'vitest';
import { getSegment, Segment, Subsegment } from 'aws-xray-sdk-core';
import { ServiceFactory, ServiceKey, ServiceModule } from '@composed-di/core';
import { instrument } from '@composed-di/instrumentation-core';
import {
  XrayInstrumentation,
  XrayInstrumentationOptions,
} from '../src/xrayInstrumentation';

let root: Segment;

beforeEach(() => {
  // A manually created root segment; it is never closed, so nothing is
  // emitted to an X-Ray daemon during tests.
  root = new Segment('test');
});

const makeListener = (options: XrayInstrumentationOptions = {}) =>
  new XrayInstrumentation({ segmentSource: () => root, ...options });

const allSubsegments = (parent: Segment | Subsegment): Subsegment[] => {
  const children = parent.subsegments ?? [];
  return children.flatMap((child) => [child, ...allSubsegments(child)]);
};
const byName = (name: string): Subsegment => {
  const found = allSubsegments(root).find((s) => s.name === name);
  expect(found, `expected a subsegment named ${name}`).toBeDefined();
  return found!;
};
const metadataOf = (sub: Subsegment) =>
  (sub as unknown as { metadata?: Record<string, Record<string, unknown>> })
    .metadata?.composed_di ?? {};
const annotationsOf = (sub: Subsegment) =>
  (sub as unknown as { annotations?: Record<string, unknown> }).annotations ??
  {};
// `fault` is set by Subsegment.close(error) but is missing from the SDK's
// type declarations.
const isFault = (sub: Subsegment) =>
  (sub as unknown as { fault?: boolean }).fault === true;

describe('XrayInstrumentation', () => {
  it('should record initialize and method call subsegments with annotations', async () => {
    const Key = new ServiceKey<{ greet(): string }>('svc');
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({ greet: () => 'hi' }),
    });
    const module = ServiceModule.from(instrument([factory], makeListener()));

    const svc = await module.get(Key);
    svc.greet();

    expect(annotationsOf(byName('svc.initialize'))).toMatchObject({
      composed_di_service: 'svc',
      composed_di_method: 'initialize',
      composed_di_operation: 'initialize',
    });
    expect(annotationsOf(byName('svc.greet'))).toMatchObject({
      composed_di_operation: 'call',
    });
  });

  it('should close subsegments when operations finish', async () => {
    const Key = new ServiceKey<{ greet(): string }>('svc');
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({ greet: () => 'hi' }),
    });
    const module = ServiceModule.from(instrument([factory], makeListener()));

    const svc = await module.get(Key);
    svc.greet();
    for (const sub of allSubsegments(root)) {
      expect(sub.isClosed(), `${sub.name} should be closed`).toBe(true);
    }
  });

  it('should record dispose subsegments', async () => {
    const Key = new ServiceKey<{ x: number }>('svc');
    const factory: ServiceFactory<{ x: number }, []> = {
      provides: Key,
      dependsOn: [],
      scope: undefined,
      initialize: () => ({ x: 1 }),
      dispose: () => {},
    };
    const module = ServiceModule.from(instrument([factory], makeListener()));

    await module.get(Key);
    module.dispose();
    expect(annotationsOf(byName('svc.dispose'))).toMatchObject({
      composed_di_operation: 'dispose',
    });
  });

  it('should nest subsegments of nested service calls', async () => {
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
    const module = ServiceModule.from(instrument([db, users], makeListener()));

    const svc = await module.get(UserKey);
    await svc.getUser(7);

    const getUser = byName('UserService.getUser');
    const query = byName('Database.query');
    expect(getUser.subsegments ?? []).toContain(query);
    // Both initializations happened outside any call, so they sit on the root.
    expect((root.subsegments ?? []).map((s) => s.name)).toContain(
      'UserService.initialize',
    );
  });

  it('should parent application subsegments opened inside observed methods', async () => {
    const Key = new ServiceKey<{ work(): string }>('svc');
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({
        work: () => {
          // What captured AWS SDK clients and captureFunc do internally:
          // attach a subsegment to the SDK's ambient segment.
          getSegment()!.addNewSubsegment('app.manual').close();
          return 'done';
        },
      }),
    });
    const module = ServiceModule.from(instrument([factory], makeListener()));

    const svc = await module.get(Key);
    expect(svc.work()).toBe('done');
    expect((byName('svc.work').subsegments ?? []).map((s) => s.name)).toContain(
      'app.manual',
    );
  });

  it('should mark failed operations as faults with the exception', async () => {
    const Key = new ServiceKey<{ boom(): never }>('svc');
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({
        boom: () => {
          throw new Error('kaput');
        },
      }),
    });
    const module = ServiceModule.from(instrument([factory], makeListener()));

    const svc = await module.get(Key);
    expect(() => svc.boom()).toThrow('kaput');

    const span = byName('svc.boom');
    expect(isFault(span)).toBe(true);
    expect(span.isClosed()).toBe(true);
  });

  it('should mark rejected async operations as faults when the promise settles', async () => {
    const Key = new ServiceKey<{ fail(): Promise<never> }>('svc');
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({
        fail: async () => {
          throw new Error('async kaput');
        },
      }),
    });
    const module = ServiceModule.from(instrument([factory], makeListener()));

    const svc = await module.get(Key);
    await expect(svc.fail()).rejects.toThrow('async kaput');
    expect(isFault(byName('svc.fail'))).toBe(true);
  });

  it('should observe nothing and stay silent without an active segment', async () => {
    const Key = new ServiceKey<{ greet(): string }>('svc');
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({ greet: () => 'hi' }),
    });
    // No segmentSource, and the SDK's ambient getSegment() throws here
    // because no X-Ray context is in flight. Services must still work.
    const module = ServiceModule.from(instrument([factory], new XrayInstrumentation()));

    const svc = await module.get(Key);
    expect(svc.greet()).toBe('hi');
  });

  it('should keep working when the segment source itself throws', async () => {
    const Key = new ServiceKey<{ greet(): string }>('svc');
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({ greet: () => 'hi' }),
    });
    const module = ServiceModule.from(
      instrument([factory], makeListener({
        segmentSource: () => {
          throw new Error('no context');
        },
      })),
    );

    const svc = await module.get(Key);
    expect(svc.greet()).toBe('hi');
    expect(allSubsegments(root)).toHaveLength(0);
  });

  it('should not capture arguments or results by default', async () => {
    const Key = new ServiceKey<{ add(a: number, b: number): number }>('svc');
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({ add: (a: number, b: number) => a + b }),
    });
    const module = ServiceModule.from(instrument([factory], makeListener()));

    const svc = await module.get(Key);
    svc.add(2, 3);
    const meta = metadataOf(byName('svc.add'));
    expect(meta.args).toBeUndefined();
    expect(meta.result).toBeUndefined();
  });

  it('should capture arguments and results when opted in', async () => {
    const Key = new ServiceKey<{ add(a: number, b: number): number }>('svc');
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({ add: (a: number, b: number) => a + b }),
    });
    const module = ServiceModule.from(
      instrument([factory], makeListener({ captureArguments: true, captureResults: true })),
    );

    const svc = await module.get(Key);
    svc.add(2, 3);
    const meta = metadataOf(byName('svc.add'));
    expect(meta.args).toBe('[2,3]');
    expect(meta.result).toBe('5');
  });

  it('should truncate captured values and long subsegment names', async () => {
    const LongKey = new ServiceKey<{ echo(s: string): string }>(
      'S'.repeat(300),
    );
    const factory = ServiceFactory.singleton({
      provides: LongKey,
      initialize: () => ({ echo: (s: string) => s }),
    });
    const module = ServiceModule.from(
      instrument([factory], makeListener({ captureArguments: true, maxCaptureLength: 10 })),
    );

    const svc = await module.get(LongKey);
    svc.echo('x'.repeat(100));

    const call = allSubsegments(root).find((s) =>
      annotationsOf(s).composed_di_method === 'echo',
    )!;
    expect(call.name).toHaveLength(200);
    const args = metadataOf(call).args as string;
    expect(args).toHaveLength(11); // 10 chars + ellipsis
    expect(args.endsWith('…')).toBe(true);
  });
});
