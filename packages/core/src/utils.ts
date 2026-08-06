import { ServiceModule } from './serviceModule'
import { ServiceKey, SelectorKey } from './serviceKey'
import type { ServiceFactory } from './serviceFactory'

export interface DotGraphOptions {
  /** Graph direction: 'TB' (top-bottom), 'LR' (left-right), 'BT' (bottom-top), 'RL' (right-left) */
  direction?: 'TB' | 'LR' | 'BT' | 'RL'
  /** Title for the graph */
  title?: string
  /** Show nodes with no dependencies in a different color */
  highlightLeaves?: boolean
  /** Show nodes with no dependents in a different color */
  highlightRoots?: boolean
}

export interface MermaidGraphOptions {
  /** Graph direction: 'TB' (top-bottom), 'LR' (left-right), 'BT' (bottom-top), 'RL' (right-left) */
  direction?: 'TB' | 'LR' | 'BT' | 'RL'
  /** Show nodes with no dependencies in a different color */
  highlightLeaves?: boolean
  /** Show nodes with no dependents in a different color */
  highlightRoots?: boolean
}

/**
 * A factory's dependencies with every `SelectorKey` expanded to its grouped
 * keys — the reachability the validators use.
 */
function expandedDependencies(factory: ServiceFactory): ServiceKey<unknown>[] {
  return factory.dependsOn.flatMap((dependency) =>
    dependency instanceof SelectorKey ? dependency.values : [dependency],
  )
}

/**
 * Orders factories so every dependent precedes its dependencies, breaking
 * ties by registration order — the rendered graph does not depend on how the
 * module was assembled.
 */
function topologicalFactories(factories: ServiceFactory[]): ServiceFactory[] {
  const bySymbol = new Map<symbol, ServiceFactory>()
  for (const factory of factories) {
    bySymbol.set(factory.provides.symbol, factory)
  }

  const visited = new Set<symbol>()
  const postOrder: ServiceFactory[] = []

  function visit(factory: ServiceFactory): void {
    if (visited.has(factory.provides.symbol)) {
      return
    }
    visited.add(factory.provides.symbol)
    for (const key of expandedDependencies(factory)) {
      const dependency = bySymbol.get(key.symbol)
      if (dependency) {
        visit(dependency)
      }
    }
    postOrder.push(factory)
  }

  for (const factory of factories) {
    visit(factory)
  }
  return postOrder.reverse()
}

/**
 * Escapes special characters in strings for DOT notation
 */
function escapeDotString(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/**
 * Escapes special characters in strings for Mermaid notation
 */
function escapeMermaidString(str: string): string {
  return str.replace(/"/g, '#quot;')
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
  const factories = topologicalFactories(module.factories)
  const lines: string[] = []

  // Start the digraph
  lines.push('digraph ServiceDependencies {')
  lines.push(`  label="${title}";`)
  lines.push('  labelloc="t";')
  lines.push('  fontsize=16;')
  lines.push(`  rankdir=${direction};`)
  lines.push('')

  // Default node styling
  lines.push('  node [')
  lines.push('    shape=box,')
  lines.push('    style="rounded,filled",')
  lines.push('    fillcolor="#e1f5ff",')
  lines.push('    color="#0288d1",')
  lines.push('    fontname="Arial",')
  lines.push('    fontsize=12')
  lines.push('  ];')
  lines.push('')

  // Default edge styling
  lines.push('  edge [')
  lines.push('    color="#666666",')
  lines.push('    arrowsize=0.8')
  lines.push('  ];')
  lines.push('')

  // Build dependency maps to identify leaves and roots
  const hasDependencies = new Set<string>()
  const hasDependents = new Set<string>()

  factories.forEach((factory) => {
    const serviceName = factory.provides.name

    if (factory.dependsOn.length > 0) {
      hasDependencies.add(serviceName)
    }

    expandedDependencies(factory).forEach((key) => {
      hasDependents.add(key.name)
    })
  })

  // Define nodes with special styling for leaves and roots
  const nodeIds = new Map<string, string>()
  let nodeCounter = 0

  factories.forEach((factory) => {
    const serviceName = factory.provides.name
    const nodeId = `node${nodeCounter++}`
    nodeIds.set(serviceName, nodeId)

    const isLeaf = !hasDependencies.has(serviceName)
    const isRoot = !hasDependents.has(serviceName)

    let nodeStyle = ''

    if (highlightLeaves && isLeaf) {
      nodeStyle = ' [fillcolor="#c8e6c9", color="#388e3c"]'
    } else if (highlightRoots && isRoot) {
      nodeStyle = ' [fillcolor="#ffccbc", color="#d84315"]'
    }

    lines.push(
      `  ${nodeId} [label="${escapeDotString(serviceName)}"]${nodeStyle};`,
    )
  })

  // Selector keys become decision nodes of their own.
  const selectors: SelectorKey<unknown>[] = []
  factories.forEach((factory) => {
    factory.dependsOn.forEach((dependency) => {
      if (dependency instanceof SelectorKey && !nodeIds.has(dependency.name)) {
        const nodeId = `node${nodeCounter++}`
        nodeIds.set(dependency.name, nodeId)
        selectors.push(dependency)
        // Labeled by what it is, not what it groups — the dashed edges
        // already show the implementations.
        lines.push(
          `  ${nodeId} [label="SelectorKey", shape=diamond, style="filled", fillcolor="#ede7f6", color="#5e35b1"];`,
        )
      }
    })
  })

  lines.push('')

  // Define edges (dependencies)
  factories.forEach((factory) => {
    const serviceName = factory.provides.name
    const serviceNodeId = nodeIds.get(serviceName)!

    factory.dependsOn.forEach((dependency) => {
      const depNodeId = nodeIds.get(dependency.name)

      if (depNodeId) {
        // Arrow points from dependent to dependency (what needs it -> what provides it)
        lines.push(`  ${serviceNodeId} -> ${depNodeId};`)
      }
    })
  })

  // A selector's outgoing edges are dashed — a runtime choice among the
  // grouped implementations, not a hard dependency on any one of them.
  selectors.forEach((selector) => {
    const selectorNodeId = nodeIds.get(selector.name)!
    selector.values.forEach((value) => {
      const valueNodeId = nodeIds.get(value.name)
      if (valueNodeId) {
        lines.push(`  ${selectorNodeId} -> ${valueNodeId} [style=dashed];`)
      }
    })
  })

  // Close the digraph
  lines.push('}')

  return lines.join('\n')
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
  console.log(createDotGraph(module, options))
  console.log('\n\nCopy the DOT output above and paste it into:')
  console.log('https://dreampuf.github.io/GraphvizOnline/')
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
  const factories = topologicalFactories(module.factories)
  const lines: string[] = []

  // Start the flowchart
  lines.push(`flowchart ${direction}`)

  // Build dependency maps to identify leaves and roots
  const hasDependencies = new Set<string>()
  const hasDependents = new Set<string>()

  factories.forEach((factory) => {
    const serviceName = factory.provides.name

    if (factory.dependsOn.length > 0) {
      hasDependencies.add(serviceName)
    }

    expandedDependencies(factory).forEach((key) => {
      hasDependents.add(key.name)
    })
  })

  // Define nodes with special styling for leaves and roots
  const nodeIds = new Map<string, string>()
  let nodeCounter = 0

  factories.forEach((factory) => {
    const serviceName = factory.provides.name
    const nodeId = `node${nodeCounter++}`
    nodeIds.set(serviceName, nodeId)

    lines.push(`  ${nodeId}["${escapeMermaidString(serviceName)}"]`)
  })

  // Selector keys become decision nodes of their own.
  const selectors: SelectorKey<unknown>[] = []
  factories.forEach((factory) => {
    factory.dependsOn.forEach((dependency) => {
      if (dependency instanceof SelectorKey && !nodeIds.has(dependency.name)) {
        const nodeId = `node${nodeCounter++}`
        nodeIds.set(dependency.name, nodeId)
        selectors.push(dependency)
        // Labeled by what it is, not what it groups — the dashed edges
        // already show the implementations.
        lines.push(`  ${nodeId}{"SelectorKey"}`)
      }
    })
  })

  lines.push('')

  // Define edges (dependencies)
  factories.forEach((factory) => {
    const serviceName = factory.provides.name
    const serviceNodeId = nodeIds.get(serviceName)!

    factory.dependsOn.forEach((dependency) => {
      const depNodeId = nodeIds.get(dependency.name)

      if (depNodeId) {
        // Arrow points from dependent to dependency (what needs it -> what provides it)
        lines.push(`  ${serviceNodeId} --> ${depNodeId}`)
      }
    })
  })

  // A selector's outgoing edges are dashed — a runtime choice among the
  // grouped implementations, not a hard dependency on any one of them.
  selectors.forEach((selector) => {
    const selectorNodeId = nodeIds.get(selector.name)!
    selector.values.forEach((value) => {
      const valueNodeId = nodeIds.get(value.name)
      if (valueNodeId) {
        lines.push(`  ${selectorNodeId} -.-> ${valueNodeId}`)
      }
    })
  })

  lines.push('')

  // Apply styling
  factories.forEach((factory) => {
    const serviceName = factory.provides.name
    const serviceNodeId = nodeIds.get(serviceName)!

    const isLeaf = !hasDependencies.has(serviceName)
    const isRoot = !hasDependents.has(serviceName)

    if (highlightLeaves && isLeaf) {
      lines.push(`  style ${serviceNodeId} fill:#c8e6c9,stroke:#388e3c`)
    } else if (highlightRoots && isRoot) {
      lines.push(`  style ${serviceNodeId} fill:#ffccbc,stroke:#d84315`)
    } else {
      // Default style
      lines.push(`  style ${serviceNodeId} fill:#e1f5ff,stroke:#0288d1`)
    }
  })

  selectors.forEach((selector) => {
    lines.push(
      `  style ${nodeIds.get(selector.name)!} fill:#ede7f6,stroke:#5e35b1`,
    )
  })

  return lines.join('\n')
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
  console.log(createMermaidGraph(module, options))
  console.log('\n\nCopy the Mermaid output above and paste it into:')
  console.log('https://mermaid.live/')
}
