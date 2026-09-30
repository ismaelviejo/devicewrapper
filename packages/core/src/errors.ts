/** Structured, agent-readable error. Every engine failure should be one of these. */
export interface IssueDetail {
  code: string;
  message: string;
  path?: string;
  hint?: string;
}

export class DwError extends Error implements IssueDetail {
  readonly code: string;
  readonly path?: string;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(code: string, message: string, opts: { path?: string; hint?: string; details?: unknown; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "DwError";
    this.code = code;
    if (opts.path !== undefined) this.path = opts.path;
    if (opts.hint !== undefined) this.hint = opts.hint;
    if (opts.details !== undefined) this.details = opts.details;
  }

  toJSON(): IssueDetail & { details?: unknown } {
    const out: IssueDetail & { details?: unknown } = { code: this.code, message: this.message };
    if (this.path !== undefined) out.path = this.path;
    if (this.hint !== undefined) out.hint = this.hint;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

export function isDwError(e: unknown): e is DwError {
  return e instanceof DwError;
}

/** Converts a Zod-style path array into "nodes[0].screen.source". */
export function formatPath(path: ReadonlyArray<PropertyKey>, prefix = ""): string {
  let out = prefix;
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out;
}

interface ZodLikeIssue {
  path: ReadonlyArray<PropertyKey>;
  message: string;
  code?: string;
}

export function zodIssuesToDetails(issues: ReadonlyArray<ZodLikeIssue>, prefix = ""): IssueDetail[] {
  return issues.map((i) => ({
    code: "SCHEMA_INVALID",
    message: `${formatPath(i.path, prefix) || "(root)"}: ${i.message}`,
    path: formatPath(i.path, prefix),
  }));
}

export function schemaError(issues: ReadonlyArray<ZodLikeIssue>, prefix = "", what = "Input"): DwError {
  const details = zodIssuesToDetails(issues, prefix);
  const first = details.slice(0, 5).map((d) => d.message).join("; ");
  const more = details.length > 5 ? ` (+${details.length - 5} more)` : "";
  return new DwError("SCHEMA_INVALID", `${what} is invalid: ${first}${more}`, {
    path: details[0]?.path,
    details,
    hint: "Read the devicewrapper://schema/scene resource for the full format.",
  });
}
