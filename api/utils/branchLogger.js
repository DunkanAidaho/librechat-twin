// /app/api/utils/branchLogger.js
const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf, colorize } = format;

// Получаем переменные окружения
const ENABLE_BRANCH_LOGGING = process.env.ENABLE_BRANCH_LOGGING === 'true';
const BRANCH_LOG_LEVEL = process.env.BRANCH_LOG_LEVEL || 'info'; // По умолчанию 'info'

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
