const { createLogger, format, transports } = require('winston');
const { configService } = require('../server/services/Config/ConfigService');
const { combine, timestamp, printf, colorize } = format;

// Получаем конфигурацию логирования
const loggingConfig = configService.getSection('logging');
const branchConfig = loggingConfig.branch || {};

// Значения по умолчанию для конфигурации
const ENABLE_BRANCH_LOGGING = configService.getBoolean('logging.branch.enabled', false);
const BRANCH_LOG_LEVEL = configService.getString('logging.branch.level', 'info');

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
  const enabled = configService.getBoolean('logging.branch.enabled', false);
  const level = configService.getString('logging.branch.level', 'info');
  
  branchLogger.level = level;
  branchLogger.silent = !enabled;
};

module.exports = branchLogger;
