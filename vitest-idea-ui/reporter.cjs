'use strict'
// Wraps the real IntelliJ vitest reporter and patches its file-path resolver so
// test tree nodes point at the original `.ts` source instead of the compiled
// `dist/test/*.js` file vitest actually runs, restoring click-to-navigate.
//
// IntelliJ's own resolver (vitest-intellij-file-path-resolver.js) already does
// this for Angular CLI projects, but only reads a compiled file's sourcemap
// when `_JETBRAINS_VITEST_IS_NG_CLI_CONTEXT` is set, and even then resolves the
// sourcemap's `sources` entry against the project root instead of the map
// file's own directory — wrong for tsc's standard relative sourcemaps. We
// replace `resolve()` outright rather than relying on that flag.
const fs = require('fs')
const path = require('path')
const Module = require('module')

const originalReporterPath =
    process.env['_VITEST_IDE_ORIGINAL_REPORTER_PATH'] ||
    process.env['_JETBRAINS_VITEST_REPORTER_ABSOLUTE_PATH']

if (!originalReporterPath) {
    throw new Error(
        '[vitest-ide] could not determine the original IntelliJ reporter path',
    )
}

function resolveSourceFromMap(filePath) {
    try {
        const mapPath = filePath + '.map'
        if (!fs.existsSync(mapPath)) return filePath
        const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'))
        const source = Array.isArray(map.sources) && map.sources[0]
        if (!source) return filePath
        const resolved = path.resolve(path.dirname(mapPath), source)
        return fs.existsSync(resolved) ? resolved : filePath
    } catch {
        return filePath
    }
}

try {
    const scopedRequire = Module.createRequire(originalReporterPath)
    const resolverModulePath = scopedRequire.resolve(
        '../vitest-intellij-file-path-resolver.js',
    )
    const resolverModule = require(resolverModulePath)
    resolverModule.VitestIntellijFilePathResolver.prototype.resolve = function (
        filePath,
    ) {
        return resolveSourceFromMap(filePath)
    }
} catch (e) {
    process.stderr.write(
        '[vitest-ide] failed to patch IntelliJ file path resolver: ' +
            e.stack +
            '\n',
    )
}

module.exports = require(originalReporterPath)
