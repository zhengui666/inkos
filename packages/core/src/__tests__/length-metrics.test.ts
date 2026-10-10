import { describe, it, expect } from "vitest";
import {
  assertChapterLength,
  buildLengthSpec,
  countChapterLength,
  defaultChapterLength,
} from "../utils/length-metrics.js";

describe("length metrics", () => {
  it("counts Chinese chapter length using zh_chars", () => {
    expect(countChapterLength("他抬头看天。", "zh_chars")).toBe(6);
  });

  it("counts English chapter length using en_words", () => {
    expect(countChapterLength("He looked at the sky.", "en_words")).toBe(5);
  });

  it.each([
    ["can't", "can’t"],
    ["writer's", "writer’s"],
    ["O'Neil", "O’Neil"],
  ])("counts straight and curly apostrophes equally in %s", (straight, curly) => {
    expect(countChapterLength(straight, "en_words")).toBe(1);
    expect(countChapterLength(curly, "en_words")).toBe(1);
  });

  it.each([
    ["Émile brought an éclair to the café.", 7],
    ["Zoë gave Renée a naïve résumé.", 6],
  ] as const)("counts canonical accent spellings equally in %s", (prose, count) => {
    expect(countChapterLength(prose.normalize("NFC"), "en_words")).toBe(count);
    expect(countChapterLength(prose.normalize("NFD"), "en_words")).toBe(count);
  });

  it.each(["É\u0304mile", "O'É\u0304mile", "O’É\u0304mile"])(
    "keeps non-composing marks attached within a one-word bound in %s", (prose) => {
      const spec = buildLengthSpec(1, "en", { minChapterLength: 1, maxChapterLength: 1 });
      for (const spelling of [prose.normalize("NFC"), prose.normalize("NFD")]) {
        expect(countChapterLength(spelling, "en_words")).toBe(1);
        expect(() => assertChapterLength(spelling, spec)).not.toThrow();
        expect(() => assertChapterLength(`${spelling} arrives`, spec)).toThrow("CHAPTER_LENGTH_OUT_OF_RANGE");
      }
    },
  );

  it("accepts equivalent apostrophe typography at explicit English bounds", () => {
    const prose = "James can't visit O'Neil today.";
    const spec = buildLengthSpec(5, "en", { minChapterLength: 5, maxChapterLength: 5 });

    expect(() => assertChapterLength(prose, spec)).not.toThrow();
    expect(() => assertChapterLength(prose.replaceAll("'", "’"), spec)).not.toThrow();
    expect(() => assertChapterLength(`${prose} Tomorrow.`, spec)).toThrow("CHAPTER_LENGTH_OUT_OF_RANGE");
    expect(() => assertChapterLength("James can't visit.", spec)).toThrow("CHAPTER_LENGTH_OUT_OF_RANGE");
  });

  it.each([
    ["well-known state-of-the-art", 6],
    ["2026 3.14 1,000 42nd B2B", 7],
  ] as const)("preserves existing hyphen and numeric counts in %s", (prose, count) => {
    expect(countChapterLength(prose, "en_words")).toBe(count);
  });

  it("keeps en_words limited to Latin words and ASCII digits", () => {
    expect(countChapterLength("Hello 中文 κόσμος мир １２３", "en_words")).toBe(1);
    expect(countChapterLength("\u0304 中文\u0304 κόσμος\u0301 мир\u0304", "en_words")).toBe(0);
  });

  it("preserves whitespace removal and raw character counts in zh_chars", () => {
    expect(countChapterLength("中 é。\n", "zh_chars")).toBe(3);
    expect(countChapterLength("中 e\u0301。\n", "zh_chars")).toBe(4);
  });

  it("defaults chapter length to the language-native unit", () => {
    expect(defaultChapterLength("zh")).toBe(2400);
    expect(defaultChapterLength("en")).toBe(2000);
    expect(defaultChapterLength()).toBe(2400);
  });

  it.each([
    ["zh_chars", "陈风抬头看天。", 7],
    ["en_words", "Émile can't visit O’Neil today.", 5],
  ] as const)("counts prose only for markdown-shaped chapters in %s", (mode, prose, count) => {
    const markdownChapter = [
      "\uFEFF---",
      "title: 第1章 归来",
      "---",
      "",
      "# 第1章 归来",
      "",
      "```text",
      "Excluded code 中文",
      "```",
      "~~~text",
      "More excluded code 中文",
      "~~~",
      prose,
      "---",
      "...",
    ].join("\r\n");

    expect(countChapterLength(markdownChapter, mode)).toBe(count);
  });

  it("keeps only the user's target and language-native counting mode", () => {
    const spec = buildLengthSpec(2200, "zh");

    expect(spec).toEqual({
      target: 2200,
      countingMode: "zh_chars",
    });
    expect(buildLengthSpec(2200, "en")).toEqual({
      target: 2200,
      countingMode: "en_words",
    });
  });
});
