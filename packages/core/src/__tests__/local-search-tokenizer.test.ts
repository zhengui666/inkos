import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { tokenizeSearchText } from "../retrieval/local-search.js";

// Compatibility oracle for bounded inputs only: the final regex is the old
// implementation whose repeated suffix scans must not return to production.
function legacyTokenize(text: string): string[] {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  const tokens: string[] = [];
  for (const part of segmenter.segment(normalized)) {
    const token = part.segment.trim();
    if (!part.isWordLike || !token) continue;
    if (/^[\p{Script=Latin}\p{N}_-]+$/u.test(token) && token.length < 2) continue;
    tokens.push(token);
  }
  const segmentedTokenCount = tokens.length;
  for (let index = 0; index < segmentedTokenCount - 1; index += 1) {
    const left = tokens[index] ?? "";
    const right = tokens[index + 1] ?? "";
    if (/^\p{Script=Han}$/u.test(left) && /^\p{Script=Han}$/u.test(right)) tokens.push(`${left}${right}`);
  }
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)+/gu)) tokens.push(match[0]);
  return tokens;
}

describe("tokenizeSearchText compatibility and scaling", () => {
  it.each([
    "",
    "mentor-debt co_author A-B 1_2",
    "-alpha beta_ x--y foo__bar a-_b",
    "a-b-c d_e-f x-y--z-w alpha-beta_42",
    "汉-字 权_衡 русский-текст عربى_اسم",
    "ＦＯＯ－ＢＡＲ foo＿bar Ａ－Ｂ １２＿３４",
    "a\u0301-b a\u0308_z x\u0301-y क्-ष",
    "𠀀-𠀁 𐐀_𐐁 Ⅷ-Ⅸ ²_³",
    "foo—bar foo–bar foo−bar foo/bar foo.bar foo'bar",
    "权🙂衡\n\n词\t字\u0000a-b\uD800c_d",
    "alpha-beta alpha-beta foo_bar foo_bar",
  ])("preserves every token, duplicate and ordering for %j", (text) => {
    expect(tokenizeSearchText(text)).toEqual(legacyTokenize(text));
  });

  it.each([
    ["ASCII", ["a", "Z", "7", "word", "-", "_"]],
    ["Han", ["权", "衡", "𠀀", "字", "-", "_"]],
    ["mixed scripts", ["é", "Ω", "Ж", "ع", "क", "权", "2", "-", "_"]],
    ["normalization", ["Ａ", "２", "＿", "－", "Ⅸ", "e\u0301", "x\u0301"]],
    ["symbols and boundaries", ["a", "字", "-", "_", "--", "__", "-_-", "🙂", "\n\n", " ", "'", "—", "\uD800"]],
  ])("matches the legacy tokenizer across deterministic %s inputs", (_name, alphabet) => {
    let seed = 0x51f15e;
    for (let sample = 0; sample < 80; sample += 1) {
      let text = "";
      for (let index = 0; index < sample + 1; index += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        text += alphabet[seed % alphabet.length];
      }
      expect(tokenizeSearchText(text)).toEqual(legacyTokenize(text));
    }
  });

  it("tokenizes complete long inputs within a hard subprocess deadline", () => {
    const moduleUrl = new URL("../retrieval/local-search.ts", import.meta.url).href;
    // A subprocess deadline also stops a synchronous regex regression; a
    // Vitest timeout alone cannot interrupt a blocked JavaScript event loop.
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { tokenizeSearchText } from ${JSON.stringify(moduleUrl)};
      const n = 120_000;
      const hanTokens = [...Array(n).fill('权'), ...Array(n - 1).fill('权权')];
      const cases = [
        ['unbroken Han', '权'.repeat(n), hanTokens],
        ['unbroken ASCII', 'a'.repeat(n), ['a'.repeat(n)]],
        ['dangling separator', 'a'.repeat(n) + '-', ['a'.repeat(n)]],
        ['paragraphs', ('权'.repeat(100) + '。\\n\\n').repeat(n / 100), hanTokens],
        ['ASCII joins', 'alpha-beta_42 '.repeat(10_000), [
          ...Array.from({length: 10_000}, () => ['alpha', 'beta_42']).flat(),
          ...Array(10_000).fill('alpha-beta_42'),
        ]],
        ['mixed joins', '权a-衡2_b '.repeat(15_000), [
          ...Array.from({length: 15_000}, () => ['权', '衡', '2_b']).flat(),
          ...Array(15_000).fill('权衡'), ...Array(15_000).fill('权a-衡2_b'),
        ]],
      ];
      for (const [name, text, expected] of cases) {
        const actual = tokenizeSearchText(text);
        assert.deepEqual(actual, expected, name);
      }
      console.log('verified all six complete token arrays');
    `], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("verified all six complete token arrays");
  });
});
