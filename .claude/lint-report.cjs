// Compact lint report: file:line rule message (ESLint 10 dropped the
// compact/unix formatters, so we parse the JSON output ourselves).
const { execSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
let json;
try {
  json = execSync(
    'npx --prefix .claude/tooling eslint --no-config-lookup --config .claude/tooling/eslint.config.mjs --format json "src/**/*.js"',
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
} catch (e) { json = e.stdout; }
let count = 0;
for (const r of JSON.parse(json)) {
  for (const m of r.messages) {
    console.log(`${path.relative(root, r.filePath)}:${m.line}  ${m.ruleId}  ${m.message}`);
    count++;
  }
}
console.log(`\n${count} problems`);
