import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/

const DI_CLASSES = new Set([
  'ServiceKey',
  'SelectorKey',
  'ServiceFactory',
  'ServiceModule',
])

/** Strips TS-only wrappers (`as`, `satisfies`, `!`, parens) around an expression. */
function unwrap(expression) {
  while (expression) {
    switch (expression.type) {
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSInstantiationExpression':
      case 'ParenthesizedExpression':
        expression = expression.expression
        continue
      default:
        return expression
    }
  }
  return expression
}

/**
 * Returns the composed-di class name when the expression creates one of its
 * instances — `new ServiceKey(...)` or a static factory call such as
 * `ServiceKey.for(...)`, `ServiceFactory.singleton(...)`, `ServiceModule.from(...)`.
 */
function diClassOf(init) {
  const expression = unwrap(init)
  if (!expression) return null

  if (expression.type === 'NewExpression') {
    const { callee } = expression
    if (callee.type === 'Identifier' && DI_CLASSES.has(callee.name)) {
      return callee.name
    }
    return null
  }

  if (expression.type === 'CallExpression') {
    const { callee } = expression
    if (
      callee.type === 'MemberExpression' &&
      !callee.computed &&
      callee.object.type === 'Identifier' &&
      DI_CLASSES.has(callee.object.name)
    ) {
      return callee.object.name
    }
  }

  return null
}

const instanceNaming = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Enforce camelCase names for constants holding ServiceKey, SelectorKey, ServiceFactory, or ServiceModule instances.',
    },
  },
  create(context) {
    return {
      VariableDeclarator(node) {
        if (node.id.type !== 'Identifier') {
          return
        }
        const className = diClassOf(node.init)
        if (className === null) {
          return
        }
        const { name } = node.id
        if (CAMEL_CASE.test(name)) {
          return
        }
        const suggestion = name.charAt(0).toLowerCase() + name.slice(1)
        const hint = CAMEL_CASE.test(suggestion)
          ? ` (e.g. '${suggestion}')`
          : ''
        context.report({
          node: node.id,
          message: `Constants defining ${className} instances must be camelCase: rename '${name}'${hint}.`,
        })
      },
    }
  },
}

/** Constants that must mirror a field of their own package's manifest. */
const MANIFEST_FIELDS = new Map([
  ['SCOPE_NAME', 'name'],
  ['SCOPE_VERSION', 'version'],
])

const manifestCache = new Map()

/**
 * Reads the manifest of the package owning `filePath`, or null when there is
 * none. An unreadable or malformed manifest stops the search rather than
 * falling through to an ancestor's, so no constant is ever compared against
 * the wrong package.
 */
function nearestManifest(filePath) {
  const start = dirname(filePath)
  if (manifestCache.has(start)) {
    return manifestCache.get(start)
  }

  let directory = start
  let manifest = null
  for (;;) {
    const path = join(directory, 'package.json')
    try {
      manifest = { path, fields: JSON.parse(readFileSync(path, 'utf8')) }
      break
    } catch (error) {
      if (error.code !== 'ENOENT') break
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  manifestCache.set(start, manifest)
  return manifest
}

const manifestConstants = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Enforce that SCOPE_NAME and SCOPE_VERSION match the declaring package's manifest.",
    },
  },
  create(context) {
    return {
      VariableDeclarator(node) {
        if (node.id.type !== 'Identifier') {
          return
        }
        const field = MANIFEST_FIELDS.get(node.id.name)
        if (field === undefined) {
          return
        }
        const literal = unwrap(node.init)
        if (literal?.type !== 'Literal' || typeof literal.value !== 'string') {
          return
        }
        const manifest = nearestManifest(context.filename)
        if (manifest === null) {
          return
        }
        const declared = manifest.fields[field]
        if (typeof declared !== 'string' || declared === literal.value) {
          return
        }
        const where = relative(context.cwd, manifest.path)
        context.report({
          node: literal,
          message: `${node.id.name} is '${literal.value}' but ${where} declares '${declared}': update the constant before publishing.`,
        })
      },
    }
  },
}

export default {
  meta: {
    name: 'composed-di',
  },
  rules: {
    'instance-naming': instanceNaming,
    'manifest-constants': manifestConstants,
  },
}
