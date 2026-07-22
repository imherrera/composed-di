import { ServiceKey, ServiceModule, SelectorKey } from '@composed-di/core'
import { GraphEdge, GraphNode } from './events'

export interface ModuleGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/**
 * Extracts the dependency graph of a module: one node per factory, one edge
 * per dependency. Selector dependencies expand to an edge per grouped key
 * ("may resolve any of these").
 */
export function moduleGraph(module: ServiceModule): ModuleGraph {
  const nodes = module.factories.map((factory) => ({
    name: factory.provides.name,
  }))

  const edges = module.factories.flatMap((factory) =>
    factory.dependsOn.flatMap((dependency: ServiceKey<unknown>) => {
      const targets =
        dependency instanceof SelectorKey ? dependency.values : [dependency]
      return targets.map((target) => ({
        from: factory.provides.name,
        to: target.name,
      }))
    }),
  )

  return { nodes, edges }
}
