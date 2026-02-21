#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const ROOT = path.join(__dirname, 'api');

function listJsFiles(dir) {
  const result = [];
  for (const item of fs.readdirSync(dir)) {
    const filePath = path.join(dir, item);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      result.push(...listJsFiles(filePath));
    } else if (item.endsWith('.js')) {
      result.push(filePath);
    }
  }
  return result;
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.error('Failed to read', filePath, error.message);
    return null;
  }
}

function parseCode(code, filePath) {
  try {
    return parser.parse(code, {
      sourceType: 'unambiguous',
      plugins: ['jsx', 'classProperties', 'dynamicImport', 'optionalChaining', 'nullishCoalescingOperator'],
    });
  } catch (error) {
    console.error('Failed to parse', filePath, error.message);
    return null;
  }
}

const files = listJsFiles(ROOT);
const fileData = {};
const parseIssues = new Map();

for (const filePath of files) {
  const relPath = path.relative(ROOT, filePath);
  const code = readFileSafe(filePath);
  if (!code) continue;
  const ast = parseCode(code, filePath);
  if (!ast) {
    console.warn('[map.skip.parse]', relPath);
    parseIssues.set(relPath, 'Parse failure');
    fileData[relPath] = {
      exports: new Set(),
      imports: [],
      calls: [],
      functions: new Set(),
      parseFailed: true,
    };
    continue;
  }

  const info = {
    exports: new Set(),
    imports: [],
    calls: [],
    functions: new Set(),
  };

  traverse(ast, {
    ImportDeclaration({ node }) {
      info.imports.push({ source: node.source.value, specifiers: node.specifiers.map((s) => s.local.name) });
    },
    VariableDeclarator({ node }) {
      if (node.init && node.init.type === 'CallExpression' && node.init.callee && node.init.callee.name === 'require') {
        const arg = node.init.arguments[0];
        const source = arg && arg.type === 'StringLiteral' ? arg.value : 'unknown';
        const specifiers = [];
        if (node.id.type === 'ObjectPattern') {
          for (const prop of node.id.properties) {
            if (prop.type === 'ObjectProperty' && prop.value.type === 'Identifier') {
              specifiers.push(prop.value.name);
            }
          }
        } else if (node.id.type === 'Identifier') {
          specifiers.push(node.id.name);
        }
        info.imports.push({ source, specifiers });
      }
    },
    FunctionDeclaration({ node }) {
      if (node.id) {
        info.functions.add(node.id.name);
      }
    },
    FunctionExpression(path) {
      const { node } = path;
      if (node.id) {
        info.functions.add(node.id.name);
      }
    },
    ArrowFunctionExpression(path) {
      const { parent } = path;
      if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
        info.functions.add(parent.id.name);
      }
    },
    CallExpression({ node }) {
      if (node.callee.type === 'Identifier') {
        info.calls.push(node.callee.name);
      } else if (node.callee.type === 'MemberExpression') {
        if (node.callee.property.type === 'Identifier') {
          info.calls.push(node.callee.property.name);
        }
      }
    },
    AssignmentExpression({ node }) {
      if (
        node.left.type === 'MemberExpression' &&
        node.left.object.type === 'Identifier' &&
        node.left.object.name === 'module' &&
        node.left.property.name === 'exports'
      ) {
        if (node.right.type === 'ObjectExpression') {
          for (const prop of node.right.properties) {
            if (prop.key && prop.key.name) {
              info.exports.add(prop.key.name);
            }
          }
        }
      }
    },
    ObjectProperty({ node, parent }) {
      if (
        parent && parent.type === 'ObjectExpression' &&
        parent.parent && parent.parent.type === 'AssignmentExpression' &&
        parent.parent.left.type === 'MemberExpression' &&
        parent.parent.left.object.name === 'module' &&
        parent.parent.left.property.name === 'exports'
      ) {
        if (node.key && node.key.name) {
          info.exports.add(node.key.name);
        }
      }
    },
    ExportNamedDeclaration({ node }) {
      if (node.declaration && node.declaration.id) {
        info.exports.add(node.declaration.id.name);
      }
      if (node.specifiers) {
        for (const spec of node.specifiers) {
          if (spec.exported && spec.exported.name) {
            info.exports.add(spec.exported.name);
          }
        }
      }
    },
    ExportDefaultDeclaration({ node }) {
      if (node.declaration.id) {
        info.exports.add(node.declaration.id.name);
      } else if (node.declaration.type === 'Identifier') {
        info.exports.add(node.declaration.name);
      } else {
        info.exports.add('default');
      }
    },
  });

  info.imports = info.imports.filter(Boolean);
  info.relPath = relPath;
  fileData[relPath] = info;
}

// Build cross references
const functionUsage = new Map();
const functionDefinitions = new Map();
const importsByFile = new Map();
for (const [relPath, info] of Object.entries(fileData)) {
  for (const fn of info.calls) {
    if (!functionUsage.has(fn)) {
      functionUsage.set(fn, new Set());
    }
    functionUsage.get(fn).add(relPath);
  }
  for (const fn of info.functions) {
    if (!functionDefinitions.has(fn)) {
      functionDefinitions.set(fn, new Set());
    }
    functionDefinitions.get(fn).add(relPath);
  }

  for (const imp of info.imports) {
    const source = imp.source;
    if (!source || source.startsWith('node:') || source.startsWith('fs') || source.startsWith('http')) {
      continue;
    }
    const normalized = source.startsWith('.')
      ? path.normalize(path.join(path.dirname(relPath), source)).replace(/^\.\//, '')
      : source;
    if (!importsByFile.has(relPath)) {
      importsByFile.set(relPath, []);
    }
    importsByFile.get(relPath).push({ source: normalized, specifiers: imp.specifiers });
  }
}

// Reverse imports to know which files depend on each file
const inboundEdges = new Map();
for (const [consumerFile, imports] of importsByFile.entries()) {
  for (const record of imports) {
    if (!inboundEdges.has(record.source)) {
      inboundEdges.set(record.source, new Set());
    }
    inboundEdges.get(record.source).add(consumerFile);
  }
}

function humanizeIdentifier(name = '') {
  if (!name || typeof name !== 'string') {
    return 'general helper';
  }
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
}

function describeFile(relPath) {
  if (relPath.includes('RAG')) return 'RAG pipeline utilities';
  if (relPath.includes('agents')) return 'Agent orchestration helpers';
  if (relPath.includes('models')) return 'Database models';
  if (relPath.includes('routes')) return 'Express routes';
  if (relPath.includes('services')) return 'Server services';
  if (relPath.includes('utils')) return 'Utility helpers';
  if (relPath.includes('clients')) return 'External API clients';
  if (relPath.includes('db')) return 'Database connectors';
  return 'General purpose module';
}

const lines = [];
lines.push('# Project Map');
lines.push('');
lines.push('Alphabetical reference of `api` JS files with call graph and statuses.');
lines.push('');

const sortedFiles = Object.keys(fileData).sort((a, b) => a.localeCompare(b));

for (const relPath of sortedFiles) {
  const info = fileData[relPath];
  lines.push(`## ${relPath}`);
  lines.push(`Purpose: ${describeFile(relPath)}`);
  if (info.parseFailed) {
    lines.push('Parse status: failed (needs manual review).');
    lines.push('');
    continue;
  }

  const inbound = inboundEdges.get(relPath);
  if (inbound && inbound.size) {
    lines.push('Inbound Links:');
    for (const consumer of Array.from(inbound).sort()) {
      const consumerInfo = fileData[consumer];
      const consumedFns = [];
      if (consumerInfo) {
        for (const fn of consumerInfo.calls) {
          if (functionDefinitions.get(fn)?.has(relPath)) {
            consumedFns.push(fn);
          }
        }
      }
      const uniqueConsumed = [...new Set(consumedFns)].sort();
      lines.push(`- used by ${consumer}${uniqueConsumed.length ? ` (calls: ${uniqueConsumed.join(', ')})` : ''}`);
    }
  } else {
    lines.push('Inbound Links: none detected');
  }
  const exportsArr = Array.from(info.exports);
  lines.push(`Exports: ${exportsArr.length ? exportsArr.join(', ') : 'None'}`);

  const functionsArr = Array.from(info.functions).sort();
  if (functionsArr.length) {
    lines.push('Functions:');
    for (const fn of functionsArr) {
      const definitionFiles = functionDefinitions.get(fn)
        ? Array.from(functionDefinitions.get(fn)).sort()
        : [];
      const usersSet = functionUsage.get(fn);
      const users = usersSet ? Array.from(usersSet).sort() : [];
      const status = users.length === 0 ? 'сирота' : 'используется';
      const duplicateNote = definitionFiles.length > 1
        ? ` | опасность, дублируется в: ${definitionFiles.join(', ')}`
        : '';
      const englishPurpose = users.length
        ? `Purpose: triggered from ${users.join(', ')} to ${humanizeIdentifier(fn)}`
        : `Purpose: local helper to ${humanizeIdentifier(fn)}`;
      lines.push(`- ${fn}: status=${status}${duplicateNote}; callers: ${users.join(', ') || '—'}; ${englishPurpose}`);
    }
  } else {
    lines.push('Functions: none detected');
  }

  const callCounts = info.calls.reduce((acc, name) => {
    acc[name] = (acc[name] || 0) + 1;
    return acc;
  }, {});
  const orderedCalls = Object.entries(callCounts).sort((a, b) => b[1] - a[1]);
  if (orderedCalls.length) {
    lines.push('Outgoing Calls:');
    for (const [name, count] of orderedCalls) {
      const targets = functionDefinitions.get(name)
        ? Array.from(functionDefinitions.get(name)).sort().join(', ')
        : 'external/unknown';
      lines.push(`- ${name}: count=${count}; defined_in=${targets}; Purpose: invokes ${humanizeIdentifier(name)}`);
    }
  } else {
    lines.push('Outgoing Calls: none detected');
  }

  lines.push('');
}
const outputPath = path.join(__dirname, 'project_map');
fs.writeFileSync(outputPath, lines.join('\n'));
console.log('project_map generated');