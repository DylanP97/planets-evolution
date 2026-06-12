// Verifies every named import between src/ modules resolves to a real export.
// Usage: node .claude/check-imports.cjs [dir]
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const target = path.join(root, process.argv[2] || 'src');

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(target);

const exportsByFile = {};
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  const names = new Set();
  for (const m of txt.matchAll(/^export (?:const|let|var|function|class) ([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of txt.matchAll(/^export \{([^}]*)\}/gm)) {
    m[1].split(',').forEach(n => { const t = n.trim().split(/\s+as\s+/).pop(); if (t) names.add(t); });
  }
  exportsByFile[path.resolve(f)] = names;
}

let bad = 0;
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  for (const m of txt.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue; // bare specifier (three etc.)
    const dest = path.resolve(path.dirname(f), spec);
    const ex = exportsByFile[dest];
    if (!ex) { console.log(`MISSING FILE  ${path.relative(root, f)} -> ${spec}`); bad++; continue; }
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0];
      if (!name) continue;
      if (!ex.has(name)) { console.log(`MISSING EXPORT  ${path.relative(root, f)}: '${name}' from ${spec}`); bad++; }
    }
  }
}
console.log(bad === 0 ? 'All imports resolve.' : `${bad} problems.`);
