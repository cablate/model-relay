// Module resolution for tools/test-hooks.mjs: imports in a hooks module resolve the way the engine resolves them.
// "claude-code/testing" is node:test's test(), and "./logic" is ./logic.ts. For a test that loads register.ts against a
// stand-in host (tools/hooks-host.mjs): "claude-code" is a minimal atom/read/update kept in memory, and the drawing
// modules (.tsx, whose JSX plain Node cannot load) are stubs that draw nothing.

const TESTING = 'data:text/javascript,export { test } from "node:test"'
const ENGINE = `data:text/javascript,${encodeURIComponent([
  'const values = new Map()',
  'export const atom = (ref, initial) => ({ ref, initial })',
  'export const read = async (_$, a) => (values.has(a) ? values.get(a) : a.initial)',
  'export const update = async (_$, a, fn) => { values.set(a, fn(values.has(a) ? values.get(a) : a.initial)) }',
].join('\n'))}`
const DRAWINGS = { './avatar': 'avatarTree', './panel': 'panelTree' }

export async function resolve(specifier, context, next) {
  if (specifier === 'claude-code/testing') return { url: TESTING, shortCircuit: true }
  if (specifier === 'claude-code') return { url: ENGINE, shortCircuit: true }
  if (Object.hasOwn(DRAWINGS, specifier)) return { url: `data:text/javascript,export const ${DRAWINGS[specifier]} = () => null`, shortCircuit: true }
  if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
}
