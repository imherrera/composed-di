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

/**
 * Escapes special characters in strings for DOT notation
 */
function escapeDotString(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
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
  options: DotGraphOptions = {},
): string {
  const {
    direction = 'TB',
    title = 'Service Dependency Graph',
    highlightLeaves = true,
    highlightRoots = true,
  } = options;

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
        // Arrow points from dependency to dependent (what provides -> what needs it)
        lines.push(`  ${depNodeId} -> ${serviceNodeId};`);
      }
    });
  });

  // Close the digraph
  lines.push('}');

  return lines.join('\n');
}

export function printGraph(module: ServiceModule) {
  const graph = createDotGraph(module, {
    direction: 'TB',
    title: 'Service Dependency Graph',
    highlightLeaves: true,
    highlightRoots: true,
  });

  console.log(graph);
  console.log('\n\nCopy the DOT output above and paste it into:');
  console.log('https://dreampuf.github.io/GraphvizOnline/');
}
