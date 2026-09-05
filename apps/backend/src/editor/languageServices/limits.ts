export interface LanguageServiceLimits {
  readonly maxFrameBytes: number;
  readonly maxQueuedStdinBytes: number;
  readonly maxStderrBytes: number;
  readonly maxDocumentBytes: number;
  readonly maxDocumentsPerProcess: number;
  readonly maxGlobalDocumentBytes: number;
  readonly maxProcesses: number;
  readonly maxProcessesPerWorkspace: number;
  readonly maxOutstandingPerSocket: number;
  readonly maxOutstandingPerProcess: number;
  readonly maxInboundSocketFrameBytes: number;
  readonly maxOutboundSocketFrameBytes: number;
  readonly maxQueuedClientFrames: number;
  readonly maxQueuedClientBytes: number;
  readonly maxQueuedSocketFrames: number;
  readonly maxQueuedSocketBytes: number;
  readonly initializeTimeoutMs: number;
  readonly featureTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly changeDebounceMs: number;
  readonly idleTimeoutMs: number;
  readonly restartWindowMs: number;
  readonly restartLimit: number;
  readonly healthyRestartResetMs: number;
}

export const DEFAULT_LANGUAGE_SERVICE_LIMITS: LanguageServiceLimits = {
  maxFrameBytes: 4 * 1024 * 1024,
  maxQueuedStdinBytes: 4 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  maxDocumentBytes: 256 * 1024,
  maxDocumentsPerProcess: 32,
  maxGlobalDocumentBytes: 32 * 1024 * 1024,
  maxProcesses: 8,
  maxProcessesPerWorkspace: 4,
  maxOutstandingPerSocket: 16,
  maxOutstandingPerProcess: 64,
  maxInboundSocketFrameBytes: 384 * 1024,
  maxOutboundSocketFrameBytes: 2 * 1024 * 1024,
  maxQueuedClientFrames: 8,
  maxQueuedClientBytes: 512 * 1024,
  maxQueuedSocketFrames: 8,
  maxQueuedSocketBytes: 512 * 1024,
  initializeTimeoutMs: 20_000,
  featureTimeoutMs: 10_000,
  shutdownTimeoutMs: 3_000,
  changeDebounceMs: 150,
  idleTimeoutMs: 10 * 60_000,
  restartWindowMs: 5 * 60_000,
  restartLimit: 3,
  healthyRestartResetMs: 10 * 60_000
};
