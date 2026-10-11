import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import { PiHostToolError, type PiHostTool, type PiSdkTool, type PiToolContext, type PiToolFailure, type PiToolResult } from "./contracts.js";

/** Tighten every object while retaining TypeBox symbols needed by the existing validator. */
function strictSchema(schema: TSchema, closeObject = true): TSchema {
  const copy = { ...schema };
  for (const [key, value] of Object.entries(copy)) {
    if (key === "properties" || key === "$defs" || key === "definitions" || key === "patternProperties") {
      copy[key] = Object.fromEntries(Object.entries(value as object).map(([name, child]) => [name, strictSchema(child as TSchema)]));
    } else if (["items", "additionalProperties", "not"].includes(key) && value && typeof value === "object" && !Array.isArray(value)) {
      copy[key] = strictSchema(value as TSchema);
    } else if (["anyOf", "allOf", "oneOf", "prefixItems", "items"].includes(key) && Array.isArray(value)) {
      copy[key] = value.map(child => strictSchema(child, key === "allOf" ? false : closeObject));
    }
  }
  if (closeObject && copy.type === "object") {
    // Intersection branches share properties; closing each branch rejects valid sibling fields.
    if (copy.allOf) copy.unevaluatedProperties ??= false;
    else copy.additionalProperties ??= false;
  }
  return copy;
}

/** Decode only schema-declared structures; scalar values never pass through Pi's coercion. */
function decodeStructures(schema: TSchema, value: unknown): unknown {
  if (typeof value === "string" && (schema.type === "object" || schema.type === "array")) value = JSON.parse(value);
  if (Array.isArray(schema.allOf)) for (const branch of schema.allOf) value = decodeStructures(branch, value);
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const branches: TSchema[] = schema.anyOf ?? schema.oneOf;
    for (const branch of branches) {
      try {
        const candidate = decodeStructures(branch, structuredClone(value));
        if (Value.Check(branch, candidate)) return candidate;
      } catch { /* Another explicit branch may accept the original value. */ }
    }
  }
  if (Array.isArray(value)) {
    const items = schema.prefixItems ?? schema.items;
    return value.map((item, index) => {
      const child = Array.isArray(items) ? items[index] : items;
      return child && typeof child === "object" ? decodeStructures(child, item) : item;
    });
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const child = schema.properties?.[key] ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined);
      return [key, child ? decodeStructures(child, item) : item];
    }));
  }
  return value;
}

function safeText(text: string): string {
  return text.replace(/Bearer\s+\S+/gi, "[redacted credential]")
    .replace(/\b(?:api[_-]?key|password|access[_-]?token|refresh[_-]?token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi, "[redacted credential]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted credential]")
    .replace(/\b[A-Za-z]:[\\/](?:[^\s"'<>]+)?/g, "[redacted path]")
    .replace(/\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+/g, "[redacted path]");
}
function safeFailure(failure?: PiToolFailure): PiToolFailure {
  if (!failure || !["recoverable", "fatal"].includes(failure.kind)
    || (failure.kind === "recoverable" && !["validation", "read"].includes(failure.category))
    || (failure.kind === "fatal" && !["owner", "guard", "persistence", "auth", "cancelled", "uncertain", "tool"].includes(failure.category))) {
    failure = { kind: "fatal", category: "uncertain" };
  }
  return { kind: failure.kind, category: failure.category,
    ...(typeof failure.feedback === "string" ? { feedback: safeText(failure.feedback) } : {}) } as PiToolFailure;
}
function classify(tool: PiHostTool, error: unknown, phase: "prepare" | "execute"): PiToolFailure {
  let failure: PiToolFailure | undefined;
  try {
    // A typed fatal host error cannot be downgraded by an optional classifier.
    failure = error instanceof PiHostToolError ? error.failure
      : error && typeof error === "object" && "failure" in error && (error as PiToolResult).failure
        ? (error as PiToolResult).failure : tool.classifyFailure?.(error, phase);
  } catch { /* Classifier failure leaves an uncertain, fatal outcome. */ }
  return safeFailure(failure);
}

/** Error payloads expose only reviewed public feedback and a receipt identifier, never arbitrary diagnostics. */
export function projectToolError(result?: Partial<Pick<PiToolResult, "details" | "failure">>, classified?: PiToolFailure): PiToolResult {
  const failure = safeFailure(classified ?? result?.failure);
  const source = result?.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
  const feedback = failure.feedback ?? (typeof source.feedback === "string" ? safeText(source.feedback) : undefined);
  // A receipt is an identifier, not a free-form diagnostic or a filesystem location.
  const receipt = typeof source.receipt === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(source.receipt)
    && !/^(?:sk-|Bearer\b|(?:api[_-]?key|password|access[_-]?token|refresh[_-]?token)[:=])/i.test(source.receipt)
    ? source.receipt : undefined;
  return {
    content: [{ type: "text", text: feedback ?? "Pi host tool failed" }],
    details: { ...(receipt ? { receipt } : {}), ...(feedback ? { feedback } : {}) }, isError: true,
    failure: { ...failure, ...(feedback ? { feedback } : {}) },
  };
}
export interface PiToolGate {
  signal(): AbortSignal;
  blocked(): boolean;
  drainEvents(): Promise<void>;
  context(): PiToolContext["context"];
  guard(context: PiToolContext, signal: AbortSignal): Promise<void>;
  complete(): void;
  reportFailure(name: string, id: string | undefined, failure: PiToolFailure): void;
  track<T>(work: Promise<T>): Promise<T>;
}
export function bridgeTools(tools: PiHostTool[], gate: PiToolGate): PiSdkTool[] {
  const names = new Set<string>();
  return tools.map(tool => {
    // Reject modifiers, glob patterns and native names so the SDK allowlist means exactly host tools.
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(tool.name) || tool.name.startsWith("mcp__") || names.has(tool.name)
      || ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell", "codemode", "tool_search"].includes(tool.name)) {
      throw new Error("Pi host tool names must be unique, literal and distinct from built-in tools");
    }
    names.add(tool.name);
    const parameters = strictSchema(tool.parameters);
    const validate = (args: unknown): unknown => {
      if (!Value.Check(parameters, args)) throw new Error("Invalid Pi host tool arguments");
      return args;
    };
    return {
      name: tool.name, label: tool.label, description: tool.description, parameters,
      executionMode: "sequential",
      prepareArguments(raw) {
        if (gate.blocked()) throw new Error("Pi host tool execution is closed");
        try { return validate(decodeStructures(parameters, structuredClone(raw))); }
        catch (error) {
          const failure = classify(tool, error, "prepare");
          gate.reportFailure(tool.name, undefined, failure);
          throw new Error(failure.feedback ?? "Invalid Pi host tool arguments");
        }
      },
      execute(id, raw, sdkSignal, onUpdate) {
        return gate.track((async () => {
          const signal = sdkSignal ? AbortSignal.any([gate.signal(), sdkSignal]) : gate.signal();
          let phase: "prepare" | "execute" = "prepare";
          try {
            await gate.drainEvents();
            signal.throwIfAborted();
            if (gate.blocked()) throw new PiHostToolError({ kind: "fatal", category: "guard" });
            const input = validate(structuredClone(raw));
            const args = validate(tool.prepareArguments ? await tool.prepareArguments(input) : input);
            try {
              await gate.guard({ toolCall: { type: "toolCall", id, name: tool.name, arguments: args as Record<string, unknown> },
                args, context: gate.context() }, signal);
            } catch { throw new PiHostToolError({ kind: "fatal", category: "guard" }); }
            signal.throwIfAborted();
            if (gate.blocked()) throw new PiHostToolError({ kind: "fatal", category: "guard" });
            phase = "execute";
            const result: PiToolResult = await tool.execute(id, args, signal, partial => {
              const update = partial as PiToolResult;
              if (update.isError || update.failure) {
                const failure = classify(tool, update, "execute");
                gate.reportFailure(tool.name, id, failure);
                onUpdate?.(projectToolError(update, failure));
              } else onUpdate?.(structuredClone(update));
            });
            if (result.isError) {
              const failure = classify(tool, result, phase);
              gate.reportFailure(tool.name, id, failure);
              return projectToolError(result, failure);
            }
            try { if (tool.completesRun?.(result)) gate.complete(); }
            catch { throw new PiHostToolError({ kind: "fatal", category: "uncertain" }); }
            return result;
          } catch (error) {
            const failure: PiToolFailure = signal.aborted ? { kind: "fatal", category: "cancelled" } : classify(tool, error, phase);
            gate.reportFailure(tool.name, id, failure);
            return projectToolError(undefined, failure);
          }
        })());
      },
    };
  });
}
