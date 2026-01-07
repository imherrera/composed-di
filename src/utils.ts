import { ServiceModule } from './serviceModule';
import { ServiceKey } from './serviceKey';

export interface DotGraphOptions {
  /** Graph direction: 'TB' (top-bottom), 'LR' (left-right), 'BT' (bottom-top), 'RL' (right-left) */
  direction?: 'TB' | 'LR' | 'BT' | 'RL';
  /** Title for the graph */
  title?: string;
  /** Show nodes with no dependencies in a different color */
  highlightLeaves?: boolean;
  /** Show nodes with no dependents in a different color */
  highlightRoots?: boolean;
}

export interface MermaidGraphOptions {
  /** Graph direction: 'TB' (top-bottom), 'LR' (left-right), 'BT' (bottom-top), 'RL' (right-left) */
  direction?: 'TB' | 'LR' | 'BT' | 'RL';
  /** Show nodes with no dependencies in a different color */
  highlightLeaves?: boolean;
  /** Show nodes with no dependents in a different color */
  highlightRoots?: boolean;
}

/**
 * Escapes special characters in strings for DOT notation
 */
function escapeDotString(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Escapes special characters in strings for Mermaid notation
 */
function escapeMermaidString(str: string): string {
  return str.replace(/"/g, '#quot;');
}

/**
 * Generates a DOT notation graph from a ServiceModule.
 * The output can be visualized using Graphviz tools or online viewers like:
 * - https://dreampuf.github.io/GraphvizOnline/
 * - https://edotor.net/
 *
 * Arrows point from dependencies to dependents (from what is needed to what needs it).
 *
 * @param module - The ServiceModule to convert to DOT notation
 * @param options - Optional configuration for the graph appearance
 * @returns A string containing the DOT notation graph
 */
export function createDotGraph(
  module: ServiceModule,
  { direction, title, highlightLeaves, highlightRoots }: DotGraphOptions = {
    direction: 'TB',
    title: 'Service Dependency Graph',
    highlightLeaves: true,
    highlightRoots: true,
  },
): string {
  const factories = module.factories;
  const lines: string[] = [];

  // Start the digraph
  lines.push('digraph ServiceDependencies {');
  lines.push(`  label="${title}";`);
  lines.push('  labelloc="t";');
  lines.push('  fontsize=16;');
  lines.push(`  rankdir=${direction};`);
  lines.push('');

  // Default node styling
  lines.push('  node [');
  lines.push('    shape=box,');
  lines.push('    style="rounded,filled",');
  lines.push('    fillcolor="#e1f5ff",');
  lines.push('    color="#0288d1",');
  lines.push('    fontname="Arial",');
  lines.push('    fontsize=12');
  lines.push('  ];');
  lines.push('');

  // Default edge styling
  lines.push('  edge [');
  lines.push('    color="#666666",');
  lines.push('    arrowsize=0.8');
  lines.push('  ];');
  lines.push('');

  // Build dependency maps to identify leaves and roots
  const hasDependencies = new Set<string>();
  const hasDependents = new Set<string>();

  factories.forEach((factory) => {
    const serviceName = factory.provides.name;

    if (factory.dependsOn.length > 0) {
      hasDependencies.add(serviceName);
    }

    factory.dependsOn.forEach((dependency: ServiceKey<unknown>) => {
      hasDependents.add(dependency.name);
    });
  });

  // Define nodes with special styling for leaves and roots
  const nodeIds = new Map<string, string>();
  let nodeCounter = 0;

  factories.forEach((factory) => {
    const serviceName = factory.provides.name;
    const nodeId = `node${nodeCounter++}`;
    nodeIds.set(serviceName, nodeId);

    const isLeaf = !hasDependencies.has(serviceName);
    const isRoot = !hasDependents.has(serviceName);

    let nodeStyle = '';

    if (highlightLeaves && isLeaf) {
      nodeStyle = ' [fillcolor="#c8e6c9", color="#388e3c"]';
    } else if (highlightRoots && isRoot) {
      nodeStyle = ' [fillcolor="#ffccbc", color="#d84315"]';
    }

    lines.push(
      `  ${nodeId} [label="${escapeDotString(serviceName)}"]${nodeStyle};`,
    );
  });

  lines.push('');

  // Define edges (dependencies)
  factories.forEach((factory) => {
    const serviceName = factory.provides.name;
    const serviceNodeId = nodeIds.get(serviceName)!;

    factory.dependsOn.forEach((dependency: ServiceKey<unknown>) => {
      const depName = dependency.name;
      const depNodeId = nodeIds.get(depName);

      if (depNodeId) {
        // Arrow points from dependent to dependency (what needs it -> what provides it)
        lines.push(`  ${serviceNodeId} -> ${depNodeId};`);
      }
    });
  });

  // Close the digraph
  lines.push('}');

  return lines.join('\n');
}

/**
 * Prints a DOT representation of a service module graph to the console.
 * The output can be used to visualize the graph using online graph visualization tools.
 *
 * @param module - The service module representing the graph to be converted into DOT format.
 * @param options - Optional configurations to customize the output of the DOT graph.
 */
export function printDotGraph(
  module: ServiceModule,
  options?: DotGraphOptions,
): void {
  console.log(createDotGraph(module, options));
  console.log('\n\nCopy the DOT output above and paste it into:');
  console.log('https://dreampuf.github.io/GraphvizOnline/');
}

/**
 * Generates a Mermaid flowchart from a ServiceModule.
 * The output can be visualized using Mermaid-compatible tools or online viewers like:
 * - https://mermaid.live/
 *
 * Arrows point from dependents to dependencies (what needs it -> what provides it).
 *
 * @param module - The ServiceModule to convert to Mermaid notation
 * @param options - Optional configuration for the graph appearance
 * @returns A string containing the Mermaid flowchart
 */
export function createMermaidGraph(
  module: ServiceModule,
  { direction, highlightLeaves, highlightRoots }: MermaidGraphOptions = {
    direction: 'TB',
    highlightLeaves: true,
    highlightRoots: true,
  },
): string {
  const factories = module.factories;
  const lines: string[] = [];

  // Start the flowchart
  lines.push(`flowchart ${direction}`);

  // Build dependency maps to identify leaves and roots
  const hasDependencies = new Set<string>();
  const hasDependents = new Set<string>();

  factories.forEach((factory) => {
    const serviceName = factory.provides.name;

    if (factory.dependsOn.length > 0) {
      hasDependencies.add(serviceName);
    }

    factory.dependsOn.forEach((dependency) => {
      hasDependents.add(dependency.name);
    });
  });

  // Define nodes with special styling for leaves and roots
  const nodeIds = new Map<string, string>();
  let nodeCounter = 0;

  factories.forEach((factory) => {
    const serviceName = factory.provides.name;
    const nodeId = `node${nodeCounter++}`;
    nodeIds.set(serviceName, nodeId);

    lines.push(`  ${nodeId}["${escapeMermaidString(serviceName)}"]`);
  });

  lines.push('');

  // Define edges (dependencies)
  factories.forEach((factory) => {
    const serviceName = factory.provides.name;
    const serviceNodeId = nodeIds.get(serviceName)!;

    factory.dependsOn.forEach((dependency) => {
      const depName = dependency.name;
      const depNodeId = nodeIds.get(depName);

      if (depNodeId) {
        // Arrow points from dependent to dependency (what needs it -> what provides it)
        lines.push(`  ${serviceNodeId} --> ${depNodeId}`);
      }
    });
  });

  lines.push('');

  // Apply styling
  factories.forEach((factory) => {
    const serviceName = factory.provides.name;
    const serviceNodeId = nodeIds.get(serviceName)!;

    const isLeaf = !hasDependencies.has(serviceName);
    const isRoot = !hasDependents.has(serviceName);

    if (highlightLeaves && isLeaf) {
      lines.push(`  style ${serviceNodeId} fill:#c8e6c9,stroke:#388e3c`);
    } else if (highlightRoots && isRoot) {
      lines.push(`  style ${serviceNodeId} fill:#ffccbc,stroke:#d84315`);
    } else {
      // Default style
      lines.push(`  style ${serviceNodeId} fill:#e1f5ff,stroke:#0288d1`);
    }
  });

  return lines.join('\n');
}

/**
 * Prints a Mermaid representation of a service module graph to the console.
 * The output can be used to visualize the graph using online Mermaid tools.
 *
 * @param module - The service module representing the graph to be converted into Mermaid format.
 * @param options - Optional configurations to customize the output of the Mermaid graph.
 */
export function printMermaidGraph(
  module: ServiceModule,
  options?: MermaidGraphOptions,
): void {
  console.log(createMermaidGraph(module, options));
  console.log('\n\nCopy the Mermaid output above and paste it into:');
  console.log('https://mermaid.live/');
}
