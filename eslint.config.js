// The gate's resolve step (#540). `node --check` parses, so a read of a name no
// enclosing scope declares passes it: a `const` declared inside one `try` and read
// from the next one threw `ReferenceError: transferDial is not defined` on every
// reconnect that connected, and it passed the gate for a day. ESLint resolves
// scopes, and `no-undef` is the rule that fails on that read.
//
// Only `no-undef` is on. A style rule here would fire on the tree's deliberate
// shape, and the gate would then report a preference instead of a bug.
import globals from 'globals'

export default [
  // htmx ships minified and the front serves it verbatim. The `find` stage beside
  // this one still parses it.
  { ignores: ['src/panel/public/vendor/**'] },
  {
    files: ['src/**/*.js', 'src/**/*.mjs', 'test/**/*.js', 'test/**/*.mjs', 'tools/**/*.js', 'tools/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: { 'no-undef': 'error' }
  },
  {
    // The panel's page script runs in a browser, so the Node identity of `document`
    // is a global this block adds rather than one the block above lacks.
    files: ['src/panel/public/**/*.js'],
    languageOptions: { globals: { ...globals.browser } }
  }
]
