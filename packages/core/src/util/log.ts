import pino from "pino";
/** Structured, privacy-safe logging: explicit redaction of every field that could carry personal data or secrets. */
export function createLogger(level = "info") {
  return pino({ level, redact: { paths: ["*.identity", "*.identityNumber", "*.password", "*.token", "*.authorization", "*.accessToken", "*.appSecret", "*.apiKey", "*.text", "*.ocrText", "req.headers.authorization"], censor: "[redacted]" }, base: { service: "promo-engine" }, timestamp: pino.stdTimeFunctions.isoTime });
}
export type Logger = ReturnType<typeof createLogger>;
export const silentLogger = () => pino({ level: "silent" });
