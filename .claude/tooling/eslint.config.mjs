// Minimal config: only correctness rules that matter for the module split.
// no-undef catches identifiers that lost their declaration during extraction;
// no-import-assign catches assignments to imported bindings (runtime TypeError).
export default [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', console: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        performance: 'readonly', navigator: 'readonly', localStorage: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        innerWidth: 'readonly', innerHeight: 'readonly', devicePixelRatio: 'readonly',
        Image: 'readonly', URL: 'readonly', Blob: 'readonly', FileReader: 'readonly',
        getComputedStyle: 'readonly', alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
        addEventListener: 'readonly', removeEventListener: 'readonly',
        atob: 'readonly', btoa: 'readonly', WebSocket: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-import-assign': 'error',
    },
  },
];
