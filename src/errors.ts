/** Thrown when a tool-call value has no faithful JSON text, which cancels compaction upstream-style. */
export class CliffCanonicalizationError extends Error {
  override readonly name = "CliffCanonicalizationError";
}

/** Thrown when a message has no content class, which cancels compaction rather than guessing. */
export class CliffMessageMappingError extends Error {
  override readonly name = "CliffMessageMappingError";
}
