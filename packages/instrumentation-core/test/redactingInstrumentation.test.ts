import { describe, it, expect } from 'vitest';
import { ServiceFactory, ServiceKey, ServiceModule } from '@composed-di/core';
import {
  instrument,
  redactionRule,
  EventOutcome,
  MethodCallContext,
  RedactingInstrumentation,
  ServiceInstrumentation,
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
class RecordingListener implements ServiceInstrumentation {
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

describe('RedactingInstrumentation', () => {
  it('redact: should redact arguments and results of the named property only', async () => {
    const recorder = new RecordingListener();
    const module = ServiceModule.from(
      instrument([secretFactory()], new RedactingInstrumentation(recorder, [
        redactionRule(SecretKey).redact('getSecret').build(),
      ])),
    );

    const svc = await module.get(SecretKey);
    svc.getSecret('db-password');
    svc.listSecretNames();

    const redacted = recorder.find('call', 'getSecret');
    expect(redacted.args).toEqual(['[REDACTED]']);
    expect(redacted.outcome).toEqual({
      type: 'success',
      value: '[REDACTED]',
    });

    const open = recorder.find('call', 'listSecretNames');
    expect(open.args).toEqual([]);
    expect(open.outcome).toEqual({
      type: 'success',
      value: ['db-password'],
    });
  });

  it('redact: should not redact the initialize result', async () => {
    const recorder = new RecordingListener();
    const module = ServiceModule.from(
      instrument([secretFactory()], new RedactingInstrumentation(recorder, [
        redactionRule(SecretKey).redact('getSecret').build(),
      ])),
    );

    await module.get(SecretKey);

    expect(recorder.find('initialize').outcome?.type).toBe('success');
    expect(recorder.find('initialize').outcome).not.toEqual({
      type: 'success',
      value: '[REDACTED]',
    });
  });

  it('redact: multiple calls accumulate properties', async () => {
    const recorder = new RecordingListener();
    const module = ServiceModule.from(
      instrument([secretFactory()], new RedactingInstrumentation(recorder, [
        redactionRule(SecretKey)
          .redact('getSecret')
          .redact('listSecretNames')
          .build(),
      ])),
    );

    const svc = await module.get(SecretKey);
    svc.getSecret('db-password');
    svc.listSecretNames();

    expect(recorder.find('call', 'getSecret').outcome).toEqual({
      type: 'success',
      value: '[REDACTED]',
    });
    expect(recorder.find('call', 'listSecretNames').outcome).toEqual({
      type: 'success',
      value: '[REDACTED]',
    });
  });

  it('redactAll + exclude: should redact every property except the excluded ones', async () => {
    const recorder = new RecordingListener();
    const module = ServiceModule.from(
      instrument([secretFactory()], new RedactingInstrumentation(recorder, [
        redactionRule(SecretKey)
          .redactAll()
          .exclude('listSecretNames')
          .build(),
        redactionRule(SecretKey)
          .redactAll()
          .exclude('listSecretNames')
          .build(),
      ])),
    );

    const svc = await module.get(SecretKey);
    svc.getSecret('db-password');
    svc.listSecretNames();

    const redacted = recorder.find('call', 'getSecret');
    expect(redacted.args).toEqual(['[REDACTED]']);
    expect(redacted.outcome).toEqual({
      type: 'success',
      value: '[REDACTED]',
    });

    const open = recorder.find('call', 'listSecretNames');
    expect(open.args).toEqual([]);
    expect(open.outcome).toEqual({
      type: 'success',
      value: ['db-password'],
    });
  });

  it('exclude alone (without redactAll or redact) throws: it would never redact anything', () => {
    expect(() =>
      redactionRule(SecretKey).exclude('listSecretNames').build(),
    ).toThrow(/has no effect/);
  });

  it('redactAll + redact(mask) + exclude all merge into a single rule', async () => {
    const recorder = new RecordingListener();
    const module = ServiceModule.from(
      instrument([secretFactory()], new RedactingInstrumentation(recorder, [
        redactionRule(SecretKey)
          .redactAll()
          .redact('getSecret', { maskArgs: (name) => `masked:${name.length}` })
          .exclude('listSecretNames')
          .build(),
      ])),
    );

    const svc = await module.get(SecretKey);
    svc.getSecret('db-password');
    svc.listSecretNames();

    // Whole-service default from redactAll redacts the initialize result.
    expect(recorder.find('initialize').outcome).toEqual({
      type: 'success',
      value: '[REDACTED]',
    });
    // getSecret: overridden with a custom arg mask; result still fully
    // blanked since no maskResult was given.
    expect(recorder.find('call', 'getSecret').args).toEqual(['masked:11']);
    expect(recorder.find('call', 'getSecret').outcome).toEqual({
      type: 'success',
      value: '[REDACTED]',
    });
    // listSecretNames: excluded, so left untouched despite redactAll.
    expect(recorder.find('call', 'listSecretNames').outcome).toEqual({
      type: 'success',
      value: ['db-password'],
    });
  });

  it('redactAll: should redact every property and the initialize result', async () => {
    const recorder = new RecordingListener();
    const module = ServiceModule.from(
      instrument([secretFactory()], new RedactingInstrumentation(recorder, [
        redactionRule(SecretKey).redactAll().build(),
      ])),
    );

    const svc = await module.get(SecretKey);
    svc.getSecret('db-password');

    expect(recorder.find('initialize').outcome).toEqual({
      type: 'success',
      value: '[REDACTED]',
    });
    expect(recorder.find('call', 'getSecret').outcome).toEqual({
      type: 'success',
      value: '[REDACTED]',
    });
  });

  it('should apply a custom mask instead of blanking the value', async () => {
    const recorder = new RecordingListener();
    const module = ServiceModule.from(
      instrument([secretFactory()], new RedactingInstrumentation(recorder, [
        redactionRule(SecretKey)
          .redact('getSecret', {
            maskArgs: (name) => `masked:${name.length}`,
            maskResult: (value) => `masked:${value.length}`,
          })
          .build(),
      ])),
    );

    const svc = await module.get(SecretKey);
    svc.getSecret('db-password');

    const call = recorder.find('call', 'getSecret');
    expect(call.args).toEqual(['masked:11']);
    expect(call.outcome).toEqual({
      type: 'success',
      value: `masked:${'value-of-db-password'.length}`,
    });
  });

  it('a redacted property without a mask is fully blanked', async () => {
    const recorder = new RecordingListener();
    const module = ServiceModule.from(
      instrument([secretFactory()], new RedactingInstrumentation(recorder, [
        redactionRule(SecretKey).redact('getSecret').build(),
      ])),
    );

    const svc = await module.get(SecretKey);
    svc.getSecret('db-password');
    svc.listSecretNames();

    expect(recorder.find('call', 'getSecret').outcome).toEqual({
      type: 'success',
      value: '[REDACTED]',
    });
    expect(recorder.find('call', 'listSecretNames').outcome).toEqual({
      type: 'success',
      value: ['db-password'],
    });
  });

  it('build() throws when neither redactAll nor redact was called', () => {
    expect(() => redactionRule(SecretKey).build()).toThrow(/has no effect/);
  });

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
      instrument([secretFactory(), plain], new RedactingInstrumentation(recorder, [
        redactionRule(SecretKey).redact('listSecretNames').build(),
      ])),
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
      instrument([factory], new RedactingInstrumentation(recorder, [
        redactionRule(BoomKey).redactAll().build(),
      ])),
    );

    const svc = await module.get(BoomKey);
    expect(() => svc.boom('hunter2')).toThrow('kaput');

    const call = recorder.find('call', 'boom');
    expect(call.args).toEqual(['[REDACTED]']);
    expect(call.outcome).toEqual({
      type: 'failure',
      error: new Error('kaput'),
    });
  });

  it("should preserve the delegate's run wrapper on redacted spans", async () => {
    const recorder = new RecordingListener();
    const module = ServiceModule.from(
      instrument([secretFactory()], new RedactingInstrumentation(recorder, [
        redactionRule(SecretKey).redactAll().build(),
      ])),
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
      instrument([factory], new RedactingInstrumentation(recorder, [
        redactionRule(factory.provides).redactAll().build(),
      ])),
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
      instrument([secretFactory()], new RedactingInstrumentation({}, [
        redactionRule(SecretKey).redactAll().build(),
      ])),
    );

    const svc = await module.get(SecretKey);
    expect(svc.getSecret('db-password')).toBe('value-of-db-password');
  });
});
