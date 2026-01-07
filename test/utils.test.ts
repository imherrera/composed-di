import { describe, it, expect } from 'vitest';
import { ServiceKey } from '../src/serviceKey';
import { ServiceFactory } from '../src/serviceFactory';
import { ServiceModule } from '../src/serviceModule';
import { createDotGraph, createMermaidGraph } from '../src/utils';

describe('utils', () => {
  describe('createDotGraph', () => {
    it('generates a valid DOT graph', () => {
      const KeyA = new ServiceKey<string>('ServiceA');
      const KeyB = new ServiceKey<string>('ServiceB');
      
      const factoryB = ServiceFactory.singleton({
        provides: KeyB,
        initialize: () => 'B',
      });

      const factoryA = ServiceFactory.singleton({
        provides: KeyA,
        dependsOn: [KeyB],
        initialize: (b) => 'A' + b,
      });

      const module = ServiceModule.from([factoryA, factoryB]);
      const dot = createDotGraph(module);

      expect(dot).toContain('digraph ServiceDependencies {');
      expect(dot).toContain('label="Service Dependency Graph";');
      expect(dot).toContain('ServiceA');
      expect(dot).toContain('ServiceB');
      // Arrow points from dependent to dependency: ServiceA -> ServiceB
      expect(dot).toMatch(/node\d+ -> node\d+/);
    });
  });

  describe('createMermaidGraph', () => {
    it('generates a valid Mermaid flowchart', () => {
      const KeyA = new ServiceKey<string>('ServiceA');
      const KeyB = new ServiceKey<string>('ServiceB');
      
      const factoryB = ServiceFactory.singleton({
        provides: KeyB,
        initialize: () => 'B',
      });

      const factoryA = ServiceFactory.singleton({
        provides: KeyA,
        dependsOn: [KeyB],
        initialize: (b) => 'A' + b,
      });

      const module = ServiceModule.from([factoryA, factoryB]);
      const mermaid = createMermaidGraph(module);

      expect(mermaid).toContain('flowchart TB');
      expect(mermaid).toContain('node0["ServiceA"]');
      expect(mermaid).toContain('node1["ServiceB"]');
      // Arrow points from dependent to dependency: ServiceA --> ServiceB
      expect(mermaid).toMatch(/node\d+ --> node\d+/);
      expect(mermaid).toContain('style node0');
      expect(mermaid).toContain('style node1');
    });

    it('handles special characters in service names', () => {
      const Key = new ServiceKey<string>('Service "Name"');
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => 'val',
      });
      const module = ServiceModule.from([factory]);
      const mermaid = createMermaidGraph(module);

      expect(mermaid).toContain('node0["Service #quot;Name#quot;"]');
    });

    it('supports different directions', () => {
      const module = ServiceModule.from([]);
      const mermaid = createMermaidGraph(module, { direction: 'LR' });
      expect(mermaid).toContain('flowchart LR');
    });
  });
});
