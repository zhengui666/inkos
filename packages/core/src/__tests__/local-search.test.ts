import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LocalSearchIndex,
  splitMarkdownForSearch,
  tokenizeSearchText,
} from "../retrieval/local-search.js";

describe("LocalSearchIndex", () => {
  it("retrieves Chinese and English evidence with FTS5 BM25", () => {
    const index = new LocalSearchIndex(":memory:");
    try {
      index.replaceScope("story", [
        {
          id: "mentor-debt",
          scope: "story",
          kind: "hook",
          source: "pending_hooks.md#mentor-debt",
          title: "师债回响 Mentor Debt",
          body: "林月必须核对誓令碎片，继续追查失踪导师留下的债务。",
        },
        {
          id: "guild-route",
          scope: "story",
          kind: "hook",
          source: "pending_hooks.md#guild-route",
          title: "商会路线 Guild Route",
          body: "商会提出一条安全但偏离主线的运输路线。",
        },
      ]);

      expect(index.search("导师 誓令 师债", { scope: "story" })[0]?.id).toBe("mentor-debt");
      expect(index.search("mentor debt oath", { scope: "story" })[0]?.id).toBe("mentor-debt");
    } finally {
      index.close();
    }
  });

  it("replaces stale projection rows instead of retaining old evidence", () => {
    const index = new LocalSearchIndex(":memory:");
    try {
      index.replaceScope("materials", [{
        id: "old",
        scope: "materials",
        kind: "reference",
        source: "old.md",
        title: "旧账",
        body: "0607 赔偿款",
      }]);
      index.replaceScope("materials", [{
        id: "new",
        scope: "materials",
        kind: "reference",
        source: "new.md",
        title: "新账",
        body: "0812 签收单",
      }]);

      expect(index.search("赔偿款", { scope: "materials" })).toEqual([]);
      expect(index.search("签收单", { scope: "materials" })[0]?.id).toBe("new");
    } finally {
      index.close();
    }
  });

  it("keeps identical document ids isolated across scopes", () => {
    const index = new LocalSearchIndex(":memory:");
    try {
      index.replaceScope("story", [{
        id: "shared",
        scope: "story",
        kind: "hook",
        source: "pending_hooks.md#shared",
        title: "失踪导师",
        body: "导师留下誓令碎片。",
      }]);
      index.replaceScope("materials", [{
        id: "shared",
        scope: "materials",
        kind: "reference",
        source: "sample.md#shared",
        title: "赔偿账页",
        body: "账页记录三笔赔偿款。",
      }]);

      expect(index.search("导师", { scope: "story" })[0]?.source).toBe("pending_hooks.md#shared");
      expect(index.search("赔偿", { scope: "materials" })[0]?.source).toBe("sample.md#shared");
    } finally {
      index.close();
    }
  });

  it("opens legacy cache rows and updates actual fields while retaining document identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inkos-search-legacy-"));
    const path = join(dir, "index.sqlite");
    let index = new LocalSearchIndex(path);
    const document = {id: "saved-id", scope: "story", kind: "hook", source: "chapter.md", title: "Mentor", body: "An old debt", metadata: {chapter: 1}};
    const db = new DatabaseSync(path);
    try {
      index.replaceScope("story", [document]);
      db.prepare("UPDATE retrieval_documents SET content_hash = 'recorded-legacy-value', updated_at = 'before-update'").run();
      index.close(); index = new LocalSearchIndex(path);
      index.replaceScope("story", [document]);
      expect(db.prepare("SELECT updated_at FROM retrieval_documents").get()?.updated_at).toBe("before-update");
      index.replaceScope("story", [{...document, body: "A new journey", metadata: {chapter: 2}}]);
      expect(index.search("debt", {scope: "story"})).toEqual([]);
      expect(index.search("journey", {scope: "story"})[0]).toMatchObject({id: "saved-id", metadata: {chapter: 2}});
      expect(db.prepare("SELECT rowid FROM retrieval_documents").get()?.rowid).toBe(1);
    } finally { index.close(); db.close(); await rm(dir, {recursive: true, force: true}); }
  });

  it("segments Markdown without truncating the selected paragraphs", () => {
    const markdown = "# 证据\n\n赔偿款被拆成三笔。\n\n## 人物\n\n司机拒绝签字。";
    const segments = splitMarkdownForSearch(markdown);

    expect(segments.map((segment) => segment.body)).toEqual([
      "赔偿款被拆成三笔。",
      "司机拒绝签字。",
    ]);
    expect(markdown.slice(segments[1]!.charStart, segments[1]!.charEnd)).toBe("司机拒绝签字。");
    expect(tokenizeSearchText("师债 mentor-debt")).toEqual(expect.arrayContaining(["师债", "mentor-debt"]));
  });
});
