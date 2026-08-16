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

export default {
    meta: {
        name: 'instance-naming',
    },
    rules: {
        'camel-case': instanceNaming,
    },
}
