// Module resolution for tools/test-hooks.mjs: imports in a hooks module resolve the way the engine resolves them.
// "claude-code/testing" is node:test's test(), and "./logic" is ./logic.ts.

const TESTING = 'data:text/javascript,export { test } from "node:test"'

export async function resolve(specifier, context, next) {
  if (specifier === 'claude-code/testing') return { url: TESTING, shortCircuit: true }
  if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
}
