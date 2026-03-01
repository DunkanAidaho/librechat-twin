const { createLogger, format, transports } = require('winston');
const { configService } = require('../server/services/Config/ConfigService');
const { combine, timestamp, printf, colorize } = format;

// Получаем конфигурацию логирования с значениями по умолчанию
const loggingConfig = configService.getSection('logging') || {};
const branchConfig = loggingConfig.branch || {};

// Значения по умолчанию для конфигурации
const ENABLE_BRANCH_LOGGING = branchConfig.enabled || false;
const BRANCH_LOG_LEVEL = branchConfig.level || 'info';

// Кастомный формат лога
const logFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} ${level}: ${message}`;
});

// Создаем логгер с настроенным форматом
const branchLogger = createLogger({
  level: BRANCH_LOG_LEVEL,
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat,
  ),
  transports: [
    new transports.Console({
      format: combine(
        colorize(),
        logFormat,
      ),
    }),
  ],
  silent: !ENABLE_BRANCH_LOGGING,
});

// Добавляем метод для обновления конфигурации
branchLogger.updateConfig = () => {
  const newConfig = configService.getSection('logging') || {};
  const newBranchConfig = newConfig.branch || {};
  
  branchLogger.level = newBranchConfig.level || 'info';
  branchLogger.silent = !(newBranchConfig.enabled || false);
};

module.exports = branchLogger;
