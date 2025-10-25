const PREFIX = process.env.LOG_PREFIX || 'BROKEX';

export function logInfo(tag, ...args) {
  console.log(`[${PREFIX}][${tag}]`, ...args);
}
export function logWarn(tag, ...args) {
  console.warn(`[${PREFIX}][${tag}]`, ...args);
}
export function logErr(tag, ...args) {
  console.error(`[${PREFIX}][${tag}]`, ...args);
}
