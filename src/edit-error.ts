export type EditErrorCode =
  | "EXPECTED_START_LINE_MISMATCH"
  | "EXPECTED_END_LINE_MISMATCH"
  | "EXPECTED_LINE_COUNT_MISMATCH"
  | "RANGE_OUT_OF_BOUNDS"
  | "INVALID_RANGE"
  | "OVERLAPPING_RANGES"
  | "TARGET_NOT_FOUND"
  | "TARGET_AMBIGUOUS"
  | "VALIDATION"
  | "EMPTY_BATCH";

export type EditFailureCandidate = {
  line: number;
  text: string;
  score?: number;
};

export type EditFailure = {
  error_code: EditErrorCode;
  message: string;
  edit_index?: number;
  op_index?: number;
  at_line?: number;
  end_line?: number;
  actual?: string;
  expected?: string;
  candidates?: EditFailureCandidate[];
  suggested?: Record<string, unknown>;
  details?: Record<string, unknown>;
};

export const SNAP_EDIT_ERROR_MARKER = "--- snap-edit-error ---";

export function formatStructuredFailure(failure: EditFailure, diagnosticSections: Array<string | undefined> = []): string {
  const body = [failure.message, ...diagnosticSections.filter((section): section is string => Boolean(section))].join("\n");
  const payload: EditFailure = {
    error_code: failure.error_code,
    message: failure.message,
  };
  if (failure.edit_index !== undefined) payload.edit_index = failure.edit_index;
  if (failure.op_index !== undefined) payload.op_index = failure.op_index;
  if (failure.at_line !== undefined) payload.at_line = failure.at_line;
  if (failure.end_line !== undefined) payload.end_line = failure.end_line;
  if (failure.actual !== undefined) payload.actual = failure.actual;
  if (failure.expected !== undefined) payload.expected = failure.expected;
  if (failure.candidates && failure.candidates.length > 0) payload.candidates = failure.candidates;
  if (failure.suggested && Object.keys(failure.suggested).length > 0) payload.suggested = failure.suggested;
  if (failure.details && Object.keys(failure.details).length > 0) payload.details = failure.details;

  return `${body}\n${SNAP_EDIT_ERROR_MARKER}\n${JSON.stringify(payload)}`;
}

export class SnapEditError extends Error {
  readonly failure: EditFailure;

  constructor(failure: EditFailure, diagnosticSections: Array<string | undefined> = []) {
    super(formatStructuredFailure(failure, diagnosticSections));
    this.name = "SnapEditError";
    this.failure = failure;
  }
}

export function throwEditError(failure: EditFailure, diagnosticSections: Array<string | undefined> = []): never {
  throw new SnapEditError(failure, diagnosticSections);
}

/** Extract structured failure from an error message or Error. */
export function parseSnapEditError(error: unknown): EditFailure | undefined {
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : undefined;
  if (!message) return undefined;

  if (error instanceof SnapEditError) return error.failure;

  const markerIndex = message.lastIndexOf(SNAP_EDIT_ERROR_MARKER);
  if (markerIndex === -1) return undefined;
  const jsonText = message.slice(markerIndex + SNAP_EDIT_ERROR_MARKER.length).trim();
  try {
    const parsed = JSON.parse(jsonText) as EditFailure;
    if (!parsed || typeof parsed !== "object" || typeof parsed.error_code !== "string" || typeof parsed.message !== "string") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}
