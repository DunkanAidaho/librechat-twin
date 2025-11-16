const fs = require('fs');
const path = require('path');

/**
 * Записывает JSON-отчёт о расходе токенов.
 * @param {Object} report
 * @param {string} report.sessionId
 * @param {number} report.totalTokens
 * @param {number} report.ragReuseCount
 * @param {Array<{messageId: string, tokens: number, isRagContext: boolean}>} report.perMessage
 * @param {string} [targetDir='./logs/token_reports']
 */
function writeTokenReport(report, targetDir = './logs/token_reports') {
  const dir = path.resolve(targetDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, `${report.sessionId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');
}

module.exports = { writeTokenReport };
