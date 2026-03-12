const fs = require('fs');
const path = require('path');

const filePath = path.join(process.cwd(), 'api/server/controllers/agents/client.js');
let content = fs.readFileSync(filePath, 'utf8');

const searchStr = `      orderedMessages = orderedMessages.map((message) => ({
        ...message,
        importance: computeImportanceScore(message),
      }));`;

const replacement = `      orderedMessages = orderedMessages.map((message) => ({
        ...message,
        importance: computeImportanceScore(message),
      }));

      const hasFreshContext = Boolean(
        (this.options?.req?.ragContextTokens > 0) ||
        (this.options?.req?.ragMultiStep?.ragContext?.entities?.length > 0)
      );`;

if (!content.includes('hasFreshContext =')) {
    content = content.replace(searchStr, replacement);
}

// Добавляем hasFreshContext в вызов processMessageHistory
content = content.replace(
    /await this\.historyManager\.processMessageHistory\(\{([\s\S]*?)\}\);/,
    (match, params) => {
        if (params.includes('hasFreshContext')) return match;
        return "await this.historyManager.processMessageHistory({" + params.trim() + ", hasFreshContext });";
    }
);

fs.writeFileSync(filePath, content);
console.log('api/server/controllers/agents/client.js patched successfully');
