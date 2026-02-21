// /app/api/utils/branchLogger.js
const { createLogger, format, transports } = require('winston');
const configService = require('~/server/services/Config/ConfigService');
const { combine, timestamp, printf, colorize } = format;

// Получаем конфигурацию логирования
const loggingConfig = configService.getSection('logging');
const branchConfig = loggingConfig.branch;
const ENABLE_BRANCH_LOGGING = branchConfig.enabled;
const BRANCH_LOG_LEVEL = branchConfig.level;

// Кастомный формат лога
const logFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} ${level}: ${message}`;
});

const branchLogger = createLogger({
  level: BRANCH_LOG_LEVEL, // Устанавливаем уровень из переменной окружения
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat,
  ),
  transports: [
    new transports.Console({
      format: combine(
        colorize(), // Добавляем цвета для консоли
        logFormat,
      ),
    }),
    // Можно добавить FileTransport для записи в файл
    // new transports.File({ filename: 'branch.log' }),
  ],
  silent: !ENABLE_BRANCH_LOGGING, // Отключаем логирование полностью, если ENABLE_BRANCH_LOGGING не true
});

module.exports = branchLogger;

