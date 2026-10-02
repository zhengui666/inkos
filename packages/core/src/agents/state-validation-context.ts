import { estimateTextTokens } from "../llm/provider.js";

/** Share exact lines across projections, retaining every occurrence and its order. */
export function renderProjectionComparison(title: string, previous: string, proposed: string): string {
  const full = `## Previous ${title}\n${previous}\n\n## Proposed ${title}\n${proposed}`;
  const lines = new Map<string, { previous: number[]; proposed: number[] }>();
  for (const [version, source] of [["previous", previous], ["proposed", proposed]] as const) {
    source.split("\n").forEach((line, index) => {
      const positions = lines.get(line) ?? { previous: [], proposed: [] };
      positions[version].push(index + 1);
      lines.set(line, positions);
    });
  }
  const compact = [
    `## ${title}: Previous / Proposed (lossless line table)`,
    "Each JSON entry is [previous line numbers, proposed line numbers, exact line text]. Line numbers are 1-based; an empty list means absent from that version. Decode JSON string escapes, place the text at every listed position in line-number order, and join with a newline (LF) to reconstruct either complete projection. No lines are omitted or summarized. Shared lines remain binding evidence in BOTH versions and must also be checked against the chapter and authority.",
    JSON.stringify([...lines].map(([line, positions]) => [positions.previous, positions.proposed, line])),
  ].join("\n");
  return estimateTextTokens(compact) < estimateTextTokens(full) ? compact : full;
}
