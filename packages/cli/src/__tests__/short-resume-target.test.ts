import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  runTool: vi.fn((..._args: unknown[]) => ({name:'fixture-short-run'})),
  execute: vi.fn(async (..._args: unknown[]) => ({data:{storyId:'english-story',finalMarkdownPath:'fixture.md',salesPackagePath:'package.md'}})),
  log: vi.fn(), logError: vi.fn(),
}));
vi.mock('@actalk/inkos-core', () => ({
  SHORT_FICTION_DEFAULT_CHAPTERS:12, SHORT_FICTION_DEFAULT_CHARS_PER_CHAPTER:1000, SHORT_FICTION_EN_DEFAULT_WORDS_PER_CHAPTER:650,
  activatedSkillIds:()=>[],createBuiltInWorkProfileRegistry:()=>({require:()=>({})}),
  createShortFictionRunTool:fixture.runTool,createShortFictionReviseTool:vi.fn(),executeExplicitCapabilityTool:fixture.execute,
  loadAvailableAgentSkills:async()=>({skills:[]}),resolveProfileSkillActivations:()=>[],PipelineRunner:class {},
  extractResponsesImageBase64:vi.fn(),resolveCoverApiKey:vi.fn(),
}));
vi.mock('../utils.js', () => ({
  buildPipelineConfig:()=>({}),findProjectRoot:()=>'/offline-fixture',loadConfig:async()=>({llm:{}}),
  log:fixture.log,logError:fixture.logError,resolveCliProfileSkills:async()=>[],
}));
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();});

describe('short CLI preserves omitted resume targets',()=>{
  it('does not turn omitted resume language/chapter count into Chinese or twelve chapters',async()=>{
    const {shortCommand}=await import('../commands/short-fiction.js');
    await shortCommand.parseAsync(['run','--story-id','english-story','--direction','Continue the accepted work','--no-cover','--json'],{from:'user'});
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.runTool.mock.calls[0]?.[2]).toMatchObject({language:undefined});
    expect(fixture.execute.mock.calls[0]?.[0]).toMatchObject({parameters:{storyId:'english-story',chapters:undefined,charsPerChapter:undefined}});
  });
  it('keeps explicit language, chapter count and target length intact',async()=>{
    const {shortCommand}=await import('../commands/short-fiction.js');
    await shortCommand.parseAsync(['run','--direction','A new English story','--lang','en','--chapters','3','--chars','200','--no-cover','--json'],{from:'user'});
    expect(fixture.runTool.mock.calls[0]?.[2]).toMatchObject({language:'en'});
    expect(fixture.execute.mock.calls[0]?.[0]).toMatchObject({parameters:{chapters:3,charsPerChapter:200}});
  });
  it('leaves default selection to the production layer for new works too',async()=>{
    const {shortCommand}=await import('../commands/short-fiction.js');
    await shortCommand.parseAsync(['run','--direction','A new story','--no-cover','--json'],{from:'user'});
    expect(fixture.runTool.mock.calls[0]?.[2]).toMatchObject({language:undefined});
    expect(fixture.execute.mock.calls[0]?.[0]).toMatchObject({parameters:{chapters:undefined}});
  });
});
