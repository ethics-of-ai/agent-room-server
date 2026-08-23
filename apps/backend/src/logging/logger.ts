import pino from "pino";

export const loggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["authToken", "authorization", "req.headers.authorization", "*.token", "*.authToken"],
    censor: "[redacted]"
  }
};

export const logger = pino({
  ...loggerOptions
});
