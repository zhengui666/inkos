import { afterEach, describe, expect, it } from "vitest";
import { renderHooksProjection } from "../../../core/src/state/state-projections.js";
import { setAppLanguage } from "./app-language";
import {
  firstParagraph,
  foundationFileLabel,
  parsePendingHooks,
  presentCurrentState,
  roleFromPath,
} from "./truth-display";

describe("truth artifact presentation", () => {
  afterEach(() => setAppLanguage("zh"));

  it("presents canonical foundation and role paths without old layout aliases", () => {
    expect(foundationFileLabel("outline/story_frame.md")).toBe("故事基石");
    expect(roleFromPath("roles/major/Mara.md")).toEqual({ path: "roles/major/Mara.md", name: "Mara", tier: "major" });
    expect(roleFromPath("character_matrix.md")).toBeNull();
    setAppLanguage("en");
    expect(foundationFileLabel("outline/story_frame.md")).toBe("Story Foundation");
  });

  it("renders current Markdown directly and extracts a readable overview", () => {
    const markdown = "# 世界观底色\n\n潮湿的港口城市，规则只对穷人生效。\n\n第二段。";
    expect(firstParagraph(markdown)).toBe("潮湿的港口城市，规则只对穷人生效。");
    expect(presentCurrentState(markdown)).toEqual({ isEmpty: false, body: markdown });
  });

  it("projects the structured hook table for the sidebar", () => {
    const hooks = parsePendingHooks([
      "| hook_id | 类型 | 状态 | 预期回收 | 备注 |",
      "| --- | --- | --- | --- | --- |",
      "| H001 | 主线伏笔 | deferred | 第五卷揭晓 | 旧账页缺了一角。 |",
    ].join("\n"));
    expect(hooks).toEqual([{ id: "H001", type: "主线伏笔", status: "deferred", payoff: "第五卷揭晓", content: "旧账页缺了一角。" }]);
  });
  it.each(["en", "zh"] as const)("round-trips escaped legacy hook cells and optional dependency columns in %s", language => {
    const values = ["Plain text", "A | B", String.raw`one\|pipe`, String.raw`two\\|pipe`, "C:\\notes\\end\\", "", "|"];
    for (const value of values) {
      const hook = { hookId: "H001", startChapter: 0, type: "mystery", status: "open" as const,
        lastAdvancedChapter: 0, expectedPayoff: value, notes: value };
      const expected = [{ id: hook.hookId, type: hook.type, status: hook.status, payoff: value, content: value }];
      expect(parsePendingHooks(renderHooksProjection({ hooks: [hook] }, language))).toEqual(expected);
      expect(parsePendingHooks(renderHooksProjection({ hooks: [{ ...hook,
        dependsOn: value ? [value] : [], paysOffInArc: value,
      }] }, language))).toEqual(expected);
    }
  });

  it("keeps cards when only dependency metadata contains pipes and preserves empty projected cells", () => {
    const hook = { hookId: "H001", startChapter: 0, type: "mystery", status: "open" as const,
      lastAdvancedChapter: 0, expectedPayoff: "", notes: "", dependsOn: [String.raw`witness\|seal`], paysOffInArc: "Return | quay" };
    expect(parsePendingHooks(renderHooksProjection({ hooks: [hook] }, "en"))).toEqual([
      { id: "H001", type: "mystery", status: "open", payoff: "", content: "" },
    ]);
  });

});
