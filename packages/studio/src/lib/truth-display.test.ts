import { afterEach, describe, expect, it } from 'vitest';
import { setAppLanguage } from './app-language';
import { firstParagraph, foundationFileLabel, parsePendingHooks, presentCurrentState, roleFromPath } from './truth-display';

describe('truth artifact presentation', () => {
  afterEach(() => setAppLanguage('zh'));
  it('presents canonical foundation and role paths without old layout aliases', () => {
    expect(foundationFileLabel('outline/story_frame.md')).toBe('故事基石');
    expect(roleFromPath('roles/major/Mara.md')).toEqual({ path: 'roles/major/Mara.md', name: 'Mara', tier: 'major' });
    expect(roleFromPath('character_matrix.md')).toBeNull();
    setAppLanguage('en');
    expect(foundationFileLabel('outline/story_frame.md')).toBe('Story Foundation');
  });
  it('renders current Markdown directly and extracts a readable overview', () => {
    const markdown = '# 世界观底色\n\n潮湿的港口城市，规则只对穷人生效。\n\n第二段。';
    expect(firstParagraph(markdown)).toBe('潮湿的港口城市，规则只对穷人生效。');
    expect(presentCurrentState(markdown)).toEqual({ isEmpty: false, body: markdown });
  });
  it('reads a structured hook table', () => {
    const hooks = parsePendingHooks([
      '| hook_id | 类型 | 状态 | 预期回收 | 备注 |',
      '| --- | --- | --- | --- | --- |',
      '| H001 | 主线伏笔 | deferred | 第五卷揭晓 | 旧账页缺了一角。 |',
    ].join('\n'));
    expect(hooks).toEqual([{ id: 'H001', type: '主线伏笔', status: 'deferred', payoff: '第五卷揭晓', content: '旧账页缺了一角。' }]);
  });
  it.each(['en', 'zh'] as const)('reads escaped hook cells and optional dependency columns in %s', language => {
    const values = ['Plain text', 'A | B', String.raw`one\|pipe`, String.raw`two\\|pipe`, 'C:\\notes\\end\\', '', '|'];
    const headings = language === 'en' ? 'hook_id | type | status | expected_payoff | notes' : 'hook_id | 类型 | 状态 | 预期回收 | 备注';
    for (const value of values) {
      const cell = value.replaceAll('|', '\\|');
      const expected = [{ id: 'H001', type: 'mystery', status: 'open', payoff: value, content: value }];
      const markdown = `| ${headings} |\n| --- | --- | --- | --- | --- |\n| H001 | mystery | open | ${cell} | ${cell} |`;
      expect(parsePendingHooks(markdown)).toEqual(expected);
      const withDependencies = `| ${headings} | depends_on | pays_off_in_arc |\n| --- | --- | --- | --- | --- | --- | --- |\n| H001 | mystery | open | ${cell} | ${cell} | ${cell} | ${cell} |`;
      expect(parsePendingHooks(withDependencies)).toEqual(expected);
    }
  });
  it('keeps cards when only dependency metadata contains pipes and preserves empty cells', () => {
    const markdown = String.raw`| hook_id | type | status | expected_payoff | notes | depends_on | pays_off_in_arc |
| --- | --- | --- | --- | --- | --- | --- |
| H001 | mystery | open |  |  | witness\\|seal | Return \| quay |`;
    expect(parsePendingHooks(markdown)).toEqual([{ id: 'H001', type: 'mystery', status: 'open', payoff: '', content: '' }]);
  });
});
