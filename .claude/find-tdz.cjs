// Flags top-level code that references an imported binding from a module in
// the same import cycle (strongly connected component) — the TDZ hazard class.
// Heuristic line scan: top-level statements and const/let initializers.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const SRC = path.join(root, 'src');

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(path.resolve(p));
  }
})(SRC);

// import graph + imported-name map
const deps = new Map();   // file -> Set(file)
const imported = new Map(); // file -> Map(name -> fromFile)
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  deps.set(f, new Set());
  imported.set(f, new Map());
  for (const m of txt.matchAll(/import\s*(?:\{([^}]*)\}|\*\s+as\s+\w+)?\s*from\s*['"]([^'"]+)['"]/g)) {
    if (!m[2].startsWith('.')) continue;
    const dest = path.resolve(path.dirname(f), m[2]);
    deps.get(f).add(dest);
    if (m[1]) for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop();
      if (name) imported.get(f).set(name, dest);
    }
  }
}

// Tarjan SCC
let idx = 0; const index = new Map(), low = new Map(), onstack = new Map(), stack = [];
const sccOf = new Map(); let sccId = 0;
function strong(v) {
  index.set(v, idx); low.set(v, idx); idx++;
  stack.push(v); onstack.set(v, true);
  for (const w of deps.get(v) || []) {
    if (!deps.has(w)) continue;
    if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (onstack.get(w)) low.set(v, Math.min(low.get(v), index.get(w)));
  }
  if (low.get(v) === index.get(v)) {
    const comp = [];
    let w;
    do { w = stack.pop(); onstack.set(w, false); comp.push(w); sccOf.set(w, sccId); } while (w !== v);
    sccId++;
  }
}
for (const f of files) if (!index.has(f)) strong(f);

// scan top-level lines
const declRe = /^export (?:const|let|var|function|class)|^(?:const|let|var|function|class)/;
let found = 0;
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  const imps = imported.get(f);
  let depth = 0, inFunc = 0;
  for (let i = 0; i < txt.length; i++) {
    const line = txt[i];
    const trimmed = line.trim();
    const atTop = depth === 0;
    if (atTop && trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*') && !/^import\b/.test(trimmed) && !/^\} from/.test(trimmed)) {
      const isFuncDecl = /^(export\s+)?(async\s+)?function\b|^(export\s+)?class\b/.test(trimmed);
      if (!isFuncDecl) {
        // collect identifiers on this line, check against same-SCC imports
        for (const idm of trimmed.matchAll(/[A-Za-z_$][\w$]*/g)) {
          const name = idm[0];
          const from = imps.get(name);
          if (from && sccOf.get(from) === sccOf.get(f) && from !== f) {
            console.log(`${path.relative(root, f)}:${i + 1}  uses '${name}' (cycle with ${path.relative(root, from)})`);
            console.log(`    ${trimmed.slice(0, 110)}`);
            found++;
            break;
          }
        }
      }
    }
    const code = line.replace(/\/\/.*$/, '');
    for (const ch of code) {
      if (ch === '{' || ch === '(') depth++;
      else if (ch === '}' || ch === ')') depth = Math.max(0, depth - 1);
    }
  }
}
console.log(found ? `\n${found} hazards` : 'no TDZ hazards found');
