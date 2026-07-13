import { describe, it, expect } from 'vitest';
import {
  redactionRule,
  EventOutcome,
  MethodCallContext,
  RedactingEventListener,
  RedactionRule,
  ServiceEventListener,
  ServiceFactory,
  ServiceKey,
  ServiceModule,
} from '../src';

interface RecordedEvent {
  type: 'initialize' | 'dispose' | 'call';
  key: ServiceKey<unknown>;
  functionName?: string;
  args?: readonly unknown[];
  outcome?: EventOutcome;
  ranWithin?: boolean;
}

/**
 * A delegate that records every context and outcome it is handed, so
 * tests can assert on exactly what crossed the redaction boundary.
 */
class RecordingListener implements ServiceEventListener {
  readonly events: RecordedEvent[] = [];

  onInitialize(context: { key: ServiceKey<unknown> }) {
    return this.record({ type: 'initialize', key: context.key });
  }

  onDispose(context: { key: ServiceKey<unknown> }) {
    return this.record({ type: 'dispose', key: context.key });
  }

  onMethodCall(context: MethodCallContext) {
    return this.record({
      type: 'call',
      key: context.key,
      functionName: context.functionName,
      args: context.args,
    });
  }

  private record(event: RecordedEvent) {
    this.events.push(event);
    return {
      run: <T>(fn: () => T): T => {
        event.ranWithin = true;
        return fn();
      },
      end: (outcome: EventOutcome) => {
        event.outcome = outcome;
      },
    };
  }

  find(type: RecordedEvent['type'], functionName?: string): RecordedEvent {
    const event = this.events.find(
      (e) =>
        e.type === type &&
        (functionName === undefined || e.functionName === functionName),
    );
    expect(event, `expected a recorded ${type} event`).toBeDefined();
    return event!;
  }
}

const SecretKey = new ServiceKey<{
  getSecret(name: string): string;
  listSecretNames(): string[];
}>('SecretClient');

const secretFactory = () =>
  ServiceFactory.singleton({
    provides: SecretKey,
    initialize: () => ({
      getSecret: (name: string) => `value-of-${name}`,
      listSecretNames: () => ['db-password'],
    }),
  });

describe('RedactingEventListener', () => {
  it('should redact arguments and results of the listed properties only', async () => {
    const recorder = new RecordingListener();
    const module = ServiceModule.from(
      [secretFactory()],
      new RedactingEventListener(recorder, [
        { key: SecretKey, properties: ['getSecret'] },
      ]),
    );

    const svc = await module.get(SecretKey);
    svc.getSecret('db-password');
    svc.listSecretNames();

    const redacted = recorder.find('call', 'getSecret');
    expect(redacted.args).toEqual(['[redacted]']);
    expect(redacted.outcome).toEqual({
      type: 'success',
      value: '[redacted]',
    });

    const open = recorder.find('call', 'listSecretNames');
    expect(open.args).toEqual([]);
    expect(open.outcome).toEqual({
      type: 'success',
      value: ['db-password'],
    });
  });

  it('should redact all properties and the initialize result when a rule omits properties', async () => {
    const recorder = new RecordingListener();
    const module = ServiceModule.from(
      [secretFactory()],
      new RedactingEventListener(recorder, [{ key: SecretKey }]),
    );

    const svc = await module.get(SecretKey);
    svc.getSecret('db-password');
    svc.listSecretNames();

    expect(recorder.find('initialize').outcome).toEqual({
      type: 'success',
      value: '[redacted]',
    });
    expect(recorder.find('call', 'getSecret').outcome).toEqual({
      type: 'success',
      value: '[redacted]',
    });
    expect(recorder.find('call', 'listSecretNames').outcome).toEqual({
      type: 'success',
      value: '[redacted]',
    });
  });

  class Foo<T> implements RedactionRule<T> {
    constructor(
      readonly key: ServiceKey<T>,
      readonly properties?: Extract<keyof T, string>[],
    ) {}
  }
  it('should not redact services outside the rules', async () => {
    const PlainKey = new ServiceKey<{ add(a: number, b: number): number }>(
      'Calculator',
    );
    const plain = ServiceFactory.singleton({
      provides: PlainKey,
      initialize: () => ({ add: (a: number, b: number) => a + b }),
    });
    const recorder = new RecordingListener();
    const module = ServiceModule.from(
      [secretFactory(), plain],
      new RedactingEventListener(recorder, [
        redactionRule(SecretKey, ['listSecretNames']),
      ]),
    );

    const calc = await module.get(PlainKey);
    calc.add(2, 3);

    const call = recorder.find('call', 'add');
    expect(call.args).toEqual([2, 3]);
    expect(call.outcome).toEqual({ type: 'success', value: 5 });
  });

  it('should pass failure outcomes through unchanged', async () => {
    const BoomKey = new ServiceKey<{ boom(secret: string): never }>('Boom');
    const factory = ServiceFactory.singleton({
      provides: BoomKey,
      initialize: () => ({
        boom: () => {
          throw new Error('kaput');
        },
      }),
    });
    const recorder = new RecordingListener();
    const module = ServiceModule.from(
      [factory],
      new RedactingEventListener(recorder, [{ key: BoomKey }]),
    );

    const svc = await module.get(BoomKey);
    expect(() => svc.boom('hunter2')).toThrow('kaput');

    const call = recorder.find('call', 'boom');
    expect(call.args).toEqual(['[redacted]']);
    expect(call.outcome).toEqual({
      type: 'failure',
      error: new Error('kaput'),
    });
  });

  it("should preserve the delegate's run wrapper on redacted spans", async () => {
    const recorder = new RecordingListener();
    const module = ServiceModule.from(
      [secretFactory()],
      new RedactingEventListener(recorder, [{ key: SecretKey }]),
    );

    const svc = await module.get(SecretKey);
    svc.getSecret('db-password');

    expect(recorder.find('call', 'getSecret').ranWithin).toBe(true);
  });

  it('should delegate dispose untouched', async () => {
    const factory: ServiceFactory<{ x: number }, []> = {
      provides: new ServiceKey<{ x: number }>('svc'),
      dependsOn: [],
      scope: undefined,
      initialize: () => ({ x: 1 }),
      dispose: () => {},
    };
    const recorder = new RecordingListener();
    const module = ServiceModule.from(
      [factory],
      new RedactingEventListener(recorder, [{ key: factory.provides }]),
    );

    await module.get(factory.provides);
    module.dispose();

    expect(recorder.find('dispose').outcome).toEqual({
      type: 'success',
      value: undefined,
    });
  });

  it('should tolerate delegates that implement no hooks', async () => {
    const module = ServiceModule.from(
      [secretFactory()],
      new RedactingEventListener({}, [{ key: SecretKey }]),
    );

    const svc = await module.get(SecretKey);
    expect(svc.getSecret('db-password')).toBe('value-of-db-password');
  });
});
