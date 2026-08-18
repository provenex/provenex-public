export const SERVER_LIMITS = Object.freeze({
  maxRequestBytes: 128 * 1024 * 1024,
  maxSourceFiles: 10_000,
  maxArtifacts: 256,
  maxRelativePathBytes: 4_096,
  maxTargetBytes: 255,
  maxArtifactNameBytes: 255,
  maxSourceFileBytes: 4 * 1024 * 1024,
  maxArtifactBytes: 64 * 1024 * 1024,
  maxAggregateContentBytes: 64 * 1024 * 1024,
});

export const DISCOVERY_LIMITS = Object.freeze({
  maxCandidateFiles: 20_000,
  maxDirectoryEntries: 100_000,
  maxDirectories: 10_000,
  maxMetadataBytes: 32 * 1024 * 1024,
  maxFirstRecordBytes: 64 * 1024,
});

export const EXCLUDE_LIMITS = Object.freeze({
  maxPatterns: 128,
  maxPatternBytes: 512,
});
