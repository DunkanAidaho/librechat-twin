const fs = require('fs');
const vm = require('vm');
const { sanitizeInput } = require('./api/utils/security');

const src = fs.readFileSync('./api/server/services/RAG/RagContextManager.js', 'utf8');
const match = src.match(/const POLICY_INTRO\s*=\s*([\s\S]*?);/);
if (!match) {
  console.error('POLICY_INTRO not found');
  process.exit(1);
}
const expr = match[1];
let POLICY_INTRO;
try {
  POLICY_INTRO = vm.runInNewContext(expr, {});
} catch (err) {
  console.error('Failed to eval POLICY_INTRO:', err.message);
  process.exit(1);
}
const intro = POLICY_INTRO.slice(0, 16).trim();
const sanitized = sanitizeInput(POLICY_INTRO).slice(0, 16).trim();
console.log('introSnippet original:', JSON.stringify(intro));
console.log('introSnippet after sanitize:', JSON.stringify(sanitized));
console.log('match:', intro === sanitized);
