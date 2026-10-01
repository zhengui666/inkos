/**
 * Codex outputSchema is strict JSON Schema. Worker contracts also contain
 * optional fields, open dictionaries and unknown JSON values, which that
 * subset cannot express without changing their semantics. Use a strict
 * transport envelope and validate the decoded value against the original
 * TypeBox contract and domain validator, exactly as for a dynamic submission.
 * This is a declared output channel, never JSON scraped from prose.
 */
export function workerOutputSchema(resultTool: string): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      resultJson: {
        type: "string",
        description: `A JSON-serialized complete argument object matching the ${resultTool} tool schema. Preserve scalar types and omit optional fields when absent.`,
      },
    },
    required: ["resultJson"],
    additionalProperties: false,
  };
}

export function decodeWorkerOutput(text: string): unknown {
  try {
    const envelope: unknown = JSON.parse(text);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
      || Object.keys(envelope).length !== 1 || !("resultJson" in envelope)
      || typeof envelope.resultJson !== "string") throw new Error();
    const result: unknown = JSON.parse(envelope.resultJson);
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result;
  } catch {
    throw Object.assign(new Error("Worker final output does not match the declared structured-result envelope"), {
      code: "WORKER_RESULT_INVALID",
    });
  }
}
