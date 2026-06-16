// One-off: print every import-graph SCC (cycle) in src/ with the edges inside it.
const fs = require('fs'), path = require('path');
const root = 'src';
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(root);
const graph = {};
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const deps = [];
  // [^;]*? lets named-import lists span newlines (no ';' appears before `from`).
  const re = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1] || m[2];
    if (spec && spec.startsWith('.')) deps.push(path.normalize(path.join(path.dirname(f), spec)));
  }
  graph[f] = deps;
}
let idx = 0;
const st = [], low = {}, num = {}, on = {}, sccs = [];
function strong(v) {
  num[v] = low[v] = idx++; st.push(v); on[v] = true;
  for (const w of graph[v] || []) {
    if (num[w] === undefined) { strong(w); low[v] = Math.min(low[v], low[w]); }
    else if (on[w]) low[v] = Math.min(low[v], num[w]);
  }
  if (low[v] === num[v]) {
    const c = []; let w;
    do { w = st.pop(); on[w] = false; c.push(w); } while (w !== v);
    if (c.length > 1) sccs.push(c);
  }
}
for (const f of files) if (num[f] === undefined) strong(f);
if (!sccs.length) console.log('No cycles.');
for (const c of sccs) {
  console.log(`=== CYCLE (${c.length} modules) ===`);
  for (const mfile of c) {
    const inCycle = (graph[mfile] || []).filter((d) => c.includes(d));
    console.log('  ' + mfile + '  ->  ' + inCycle.map((d) => path.basename(d)).join(', '));
  }
}
