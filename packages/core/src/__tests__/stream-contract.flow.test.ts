import { createServer } from "node:http";
import { once } from "node:events";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexFixture } from "./codex-fixture.js";
import { createLLMClient } from "../llm/provider.js";
import { BaseAgent } from "../agents/base.js";
import type { StreamProgress } from "../llm/provider.js";
import { guardedPiStream, guardedPiNonStreaming } from "../agent/pi-stream.js";
import { withExecutionEvidence } from "../harness/execution-evidence.js";
import { compileHarnessContextText } from "../agent/agent-session.js";
import { runWorkerAgentTool } from "../agent/worker-agent.js";

// These transport fixtures bind loopback only and must not inherit a developer's
// outbound proxy configuration. Codex protocol fixtures do not perform HTTP.
beforeEach(() => {
  for (const name of ['INKOS_LLM_PROXY_URL', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) vi.stubEnv(name, '');
});
afterEach(() => vi.unstubAllEnvs());

it.each([true, false])('enforces required tool selection without rejecting an ordinary answer (stream=%s)', async (streaming) => {
  const received: Array<{ tool_choice?: unknown }> = [];
  let completeTool = false;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const call = completeTool && received.length === 3
      ? { id: 'result-1', type: 'function', function: { name: 'submit_value', arguments: '{"value":7}' } } : undefined;
    if (streaming) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'selection', object: 'chat.completion.chunk', choices: [{ index: 0,
        delta: call ? { role: 'assistant', tool_calls: [{ ...call, index: 0 }] } : { role: 'assistant', content: 'A response.' },
        finish_reason: null }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ id: 'selection', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...(call ? { tool_calls: [call] } : { content: 'A response.' }) }, finish_reason: call ? 'tool_calls' : 'stop' }] }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const client = createLLMClient({ service: 'custom', provider: 'openai', configSource: 'studio', model: 'fixture', apiKey: 'fixture',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiFormat: 'chat', stream: streaming, temperature: 0, thinkingBudget: 0 });
    const context = { messages: [{ role: 'user' as const, content: 'Submit a value.', timestamp: 1 }],
      tools: [{ name: 'submit_value', description: 'Submit', parameters: Type.Object({ value: Type.Number() }) }] };
    const run = async (toolChoice?: unknown) => {
      const options = { apiKey: 'fixture', maxTokens: 128, toolChoice };
      const events = streaming ? guardedPiStream(client._piModel!, context, options) : guardedPiNonStreaming(client._piModel!, context, options);
      for await (const _event of events) {}
      return events.result();
    };
    expect((await run()).stopReason).toBe('stop');
    completeTool = true;
    const completed = await run('required');
    expect(completed).toMatchObject({ stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'submit_value', arguments: { value: 7 } }] });
    expect(received).toHaveLength(3);
    expect(received.slice(1).map(request => request.tool_choice)).toEqual(['required', 'required']);
    const failed = await run({ type: 'function', function: { name: 'submit_value' } });
    expect(failed).toMatchObject({ stopReason: 'error', errorCode: 'MODEL_REQUIRED_TOOL_MISSING' });
    expect(received).toHaveLength(5);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}, 15000);

it.each(["chat", "responses", "anthropic"] as const)("carries the required result tool through the real Pi %s streaming HTTP boundary", async (apiFormat) => {
  const submitted = { value: 2, flags: [true, false, 1, 0, "1", "0"] };
  const requests: Array<{tool_choice: unknown; max_tokens?: number; max_completion_tokens?: number; max_output_tokens?: number; input?: unknown; thinking?: unknown; messages: unknown}> = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (payload: unknown) => response.write(`${apiFormat !== "chat" ? `event: ${(payload as {type:string}).type}\n` : ""}data: ${JSON.stringify(payload)}\n\n`);
    if (requests.length === 1) {
      if (apiFormat === "responses") send({ type: "response.completed", response: { id: "resp_empty", status: "completed" } });
      if (apiFormat === "anthropic") {
        send({ type: "message_start", message: { id: "msg_empty", type: "message", role: "assistant", content: [], model: "fixture", usage: { input_tokens: 2, output_tokens: 0 } } });
        send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } });
        send({ type: "message_stop" }); response.end(); return;
      }
      response.end("data: [DONE]\n\n"); return;
    }
    if (apiFormat === "responses") {
      const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "submit_value", arguments: JSON.stringify(submitted) };
      send({ type: "response.created", response: { id: "resp_1" } });
      send({ type: "response.output_item.added", output_index: 0, item: {...item, arguments: ""} });
      send({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments });
      send({ type: "response.output_item.done", output_index: 0, item });
      send({ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } } });
      response.end("data: [DONE]\n\n"); return;
    }
    if (apiFormat === "anthropic") {
      send({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "fixture", usage: { input_tokens: 2, output_tokens: 0 } } });
      send({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool_1", name: "submit_value", input: {} } });
      send({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(submitted) } });
      send({ type: "content_block_stop", index: 0 });
      send({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 2 } });
      send({ type: "message_stop" });
      response.end(); return;
    }
    send({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "submit_value", arguments: JSON.stringify(submitted) } }] }, finish_reason: null }] });
    send({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } });
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address() as { port: number };
    const client = createLLMClient({ service: "custom", configSource: "studio", provider: "openai", model: "deepseek-v4-flash", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-key", apiFormat, stream: true, temperature: 0, thinkingBudget: 0 });
    const options = {apiKey:'fixture-key',maxTokens:128,toolChoice:'required'};
    const stream = guardedPiStream(client._piModel!, { messages: [{role:'user',content:'Submit the requested integer.',timestamp:1}],
      tools: [{name:'submit_value',description:'Submit values',parameters:Type.Object({
        value:Type.Integer(),flags:Type.Array(Type.Union([Type.Number(),Type.String(),Type.Boolean()])),
      })}],
    }, options);
    for await (const _event of stream) {}
    expect((await stream.result()).content).toEqual(expect.arrayContaining([
      expect.objectContaining({type:'toolCall',name:'submit_value',arguments:submitted}),
    ]));
    expect(requests).toHaveLength(2);
    expect(requests[0]?.messages).toEqual(requests[1]?.messages);
    if (apiFormat === "anthropic") {
      expect(requests[0]?.tool_choice).toEqual({ type: "auto" });
      expect(requests[0]?.max_tokens).toBe(128);
      return;
    }
    if (apiFormat === "responses") {
      expect(requests[0]?.input).toEqual(requests[1]?.input);
      expect(requests[0]?.max_output_tokens).toBe(128);
      expect(requests[0]?.tool_choice).toBe("required");
      return;
    }
    expect(requests[0]?.max_tokens).toBe(128);
    expect(requests[0]?.max_completion_tokens).toBeUndefined();
    expect(requests[0]?.thinking).toEqual({ type: "disabled" });
    expect(requests[0]?.tool_choice).toBe("required");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}, 15000);

it("records received partial tool output when a live stream is cancelled", async () => {
  let calls=0;
  const server = createServer(async (request,response) => {
    calls++;
    for await (const _ of request) { /* Drain the request before responding. */ }
    response.writeHead(200, {"Content-Type":"text/event-stream"});
    response.write(`data: ${JSON.stringify({id:'partial',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call-partial',type:'function',function:{name:'submit_value',arguments:'{"value":2}'}}]},finish_reason:null}]})}\n\n`);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const client = createLLMClient({service:'custom',configSource:'studio',provider:'openai',model:'test-model',baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,apiKey:'fixture',apiFormat:'chat',stream:true,temperature:0,thinkingBudget:0});
    const cancellation = new AbortController();
    const evidence: Array<Record<string,unknown>> = [];
    await withExecutionEvidence((type,payload)=>{if(type==='model-call-completed')evidence.push(payload);},async()=>{
      const stream=guardedPiStream(client._piModel!,{messages:[{role:'user',content:'Submit the integer',timestamp:1}],tools:[{name:'submit_value',description:'Submit',parameters:Type.Object({value:Type.Integer()})}]},{apiKey:'fixture',maxTokens:128,signal:cancellation.signal});
      for await(const event of stream)if(event.type==='toolcall_delta')cancellation.abort();
      expect((await stream.result()).stopReason).toBe('aborted');
    });
    expect(evidence.at(-1)).toMatchObject({status:'error',partialOutput:{content:[{type:'toolCall',id:'call-partial'}]}});
    expect(calls).toBe(1);
  } finally { server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
},15000);


const createCodexClient = vi.hoisted(() => vi.fn());
vi.mock('../codex/client.js', () => ({ createCodexClient }));
const fixtureClient = () => createLLMClient({service:'custom',provider:'openai',configSource:'studio',model:'fixture',apiKey:'fixture',baseUrl:'https://unused.invalid/v1',apiFormat:'chat',stream:true,temperature:0,thinkingBudget:0});

it('ends a failed Codex turn without entering a schema-repair loop', async () => {
  const codex = new CodexFixture(() => ({error:'Codex could not complete the model response'}));
  createCodexClient.mockImplementation(codex.createClient);
  await expect(runWorkerAgentTool(fixtureClient(),'fixture',[{role:'user',content:'Submit the value.'}],{
    name:'submit_value',label:'Submit',description:'Submit the result',parameters:Type.Object({value:Type.Number()}),
  },{maxTokens:128})).rejects.toMatchObject({code:'WORKER_MODEL_ERROR',attempts:1});
  expect(codex.turns).toHaveLength(1);
  expect(codex.toolResponses).toHaveLength(0);
});

it('bounds empty completed Codex turns without accepting a missing structured result', async () => {
  const codex = new CodexFixture(() => ({text:' '}));
  createCodexClient.mockImplementation(codex.createClient);
  await expect(runWorkerAgentTool(fixtureClient(),'fixture',[{role:'user',content:'Submit the value.'}],{
    name:'submit_value',label:'Submit',description:'Submit the result',parameters:Type.Object({value:Type.Number()}),
  })).rejects.toMatchObject({code:'WORKER_RESULT_MISSING',attempts:3});
  expect(codex.turns).toHaveLength(3);
  expect(codex.toolResponses).toHaveLength(0);
});

it('carries the required result schema through Codex dynamic tools and preserves union scalar types', async () => {
  const submitted={value:2,flags:[true,false,1,0,'1','0']};
  const progress: StreamProgress[]=[];
  const codex=new CodexFixture(()=>({text:'Submitting the requested values.',calls:[{name:'submit_value',args:submitted}]}));
  createCodexClient.mockImplementation(codex.createClient);
  class FixtureAgent extends BaseAgent {
    get name(){return 'fixture';}
    async submit(){return (await this.submitStructured([{role:'user',content:'Submit the requested integer.'}],{
      name:'submit_value',label:'Submit',description:'Submit values',parameters:Type.Object({value:Type.Integer(),flags:Type.Array(Type.Union([Type.Number(),Type.String(),Type.Boolean()]))}),
    },{maxTokens:128})).result;}
  }
  expect(await new FixtureAgent({client:fixtureClient(),model:'fixture',projectRoot:'/tmp',onStreamProgress:value=>progress.push(value)}).submit()).toEqual(submitted);
  expect(progress.at(-1)?.status).toBe('done');
  expect(progress.at(-1)?.totalChars).toBeGreaterThan(0);
  const thread=codex.requests.find(request=>request.method==='thread/start')!.params;
  expect(thread).toMatchObject({model:'fixture',ephemeral:true,approvalPolicy:'never',sandbox:'read-only'});
  expect(codex.requests.find(request=>request.method==='turn/start')?.params.effort).toBe('medium');
  expect(thread.dynamicTools).toHaveLength(1);
  expect(thread.dynamicTools[0]).toMatchObject({name:'submit_value',inputSchema:{required:['value','flags']}});
  expect(thread.baseInstructions).toContain('Finish by calling submit_value exactly once');
  expect(codex.toolResponses).toHaveLength(1);
  expect(codex.toolResponses[0].response.success).toBe(true);
  expect(codex.requests.some(request=>request.method==='turn/interrupt')).toBe(true);
});

it('bounds invalid structured submissions and returns schema paths instead of echoing the entire manuscript',async()=>{
  const codex=new CodexFixture(()=>({calls:[{name:'submit_chapters',args:{chapters:'[{malformed JSON}]',state:'other'}}]}));
  createCodexClient.mockImplementation(codex.createClient);
  await expect(runWorkerAgentTool(fixtureClient(),'fixture',[{role:'user',content:'Submit chapters.'}],{
    name:'submit_chapters',label:'Submit',description:'Submit chapter records',parameters:Type.Object({chapters:Type.Array(Type.Object({number:Type.Integer()})),state:Type.Union([Type.Literal('draft'),Type.Literal('ready')])}),
  },{maxTokens:128})).rejects.toMatchObject({code:'WORKER_RESULT_INVALID',attempts:3});
  expect(codex.toolResponses).toHaveLength(3);
  const feedback=JSON.parse(codex.toolResponses[0].response.contentItems[0].text);
  expect(feedback).toMatchObject({code:'WORKER_SCHEMA_INVALID',issues:[{path:'/chapters'},{path:'/state',allowedValues:['draft','ready']}]});
  expect(Object.keys(feedback.issues[0]).sort()).toEqual(['message','path','type']);
  expect(codex.requests.filter(request=>request.method==='turn/start')).toHaveLength(1);
});

it('bounds context compilation to one text response even if Codex attempts a tool from quoted history',async()=>{
  const codex=new CodexFixture(({step})=>step===1
    ? {calls:[{name:'file_search',args:{}}],complete:true}
    : {text:'Saved the prior result; the next request remains pending.'});
  createCodexClient.mockImplementation(codex.createClient);
  const client=fixtureClient();
  const input={model:client._piModel!,apiKey:'fixture',stream:true,systemPrompt:'Summarize supplied history.',userPrompt:'Earlier tool: file_search. Its result was saved.',maxTokens:128};
  await expect(compileHarnessContextText(input)).rejects.toMatchObject({code:'CONTEXT_UNEXPECTED_TOOL_CALL'});
  expect(codex.turns).toHaveLength(1);
  expect(codex.turns[0].thread.dynamicTools).toEqual([]);
  expect(codex.toolResponses[0].response).toMatchObject({success:false});
  expect(await compileHarnessContextText({...input,model:{...input.model,contextWindow:0},userPrompt:input.userPrompt.repeat(200)})).toBeTruthy();
  expect(codex.turns).toHaveLength(2);
});

it('recovers an empty source selection with its address and materializes exact source punctuation', async () => {
  const {SourcedReviewToolSchema}=await import('../agents/review-tool.js');
  const {numberReviewSource,resolveObservationSources}=await import('../models/observation.js');
  const source='# Source\n\n他说：“等一下。”\n下一段。';
  const sources=new Map([['source-a',source]]);
  expect(resolveObservationSources([{code:'comparison',summary:'Missing baseline',assessment:'unavailable',evidence:[],sourceRefs:[]}],sources)).toMatchObject([{assessment:'unavailable',sourceRefs:[]}]);
  expect(()=>resolveObservationSources([{code:'finding',summary:'Unsupported issue',assessment:'issue',evidence:[],sourceRefs:[]}],sources)).toThrow();
  const codex=new CodexFixture(({step})=>({calls:[{name:'submit_review',args:{summary:'Scoped result',observations:[{code:'finding',summary:'Source-backed finding',assessment:'observation',evidence:[],sourceRefs:[{sourceId:'source-a',startLine:step===1?2:3,endLine:step===1?2:3}]}]}}]}));
  createCodexClient.mockImplementation(codex.createClient);
  const result=await runWorkerAgentTool(fixtureClient(),'fixture',[{role:'user',content:numberReviewSource(source)}],{
    name:'submit_review',label:'Submit',description:'Submit addressed findings',parameters:SourcedReviewToolSchema,
    validate:result=>({...result,observations:resolveObservationSources(result.observations,sources)}),
  },{maxTokens:1024});
  expect(result.observations[0].sourceRefs).toEqual([{sourceId:'source-a',quote:source.split('\n')[2]}]);
  expect(codex.toolResponses).toHaveLength(2);
  const error=JSON.parse(codex.toolResponses[0].response.contentItems[0].text);
  expect(error).toMatchObject({code:'REVIEW_SOURCE_REQUIRED',path:'/observations/0/sourceRefs/0',sourceId:'source-a',startLine:2,endLine:2,lineCount:4,nearbyLines:expect.arrayContaining([{line:3,text:source.split('\n')[2]}])});
});

it('repairs an oversized checkpoint through bounded flat chapter submissions before completing the draft', async () => {
  const {ShortFictionWriterAgent}=await import('../agents/short-fiction.js');
  const checkpoints:number[][]=[];
  const codex=new CodexFixture(({step})=>{
    const number=step===1?1:step-1;
    return {calls:[{name:'submit_short_revision_chapter',args:{title:`Chapter ${number}`,content:step===1?Array(20).fill('word').join(' '):`A complete scene for chapter ${number}.`}}]};
  });
  createCodexClient.mockImplementation(codex.createClient);
  const draft=await new ShortFictionWriterAgent({client:fixtureClient(),model:'fixture',projectRoot:'/tmp'}).continueDraft({direction:'Fixture',outlineMarkdown:'Two connected scenes.',chapterCount:2,charsPerChapter:10,maxChapterLength:10,maxChaptersPerCall:2,language:'en',draft:{storyTitle:'Fixture',rawContent:'',chapters:[{number:1,title:'Prior candidate',content:Array(30).fill('word').join(' '),charCount:1},{number:2,title:'',content:'',charCount:0}]},onBatchComplete:async(_draft,numbers)=>{checkpoints.push([...numbers]);}});
  expect(draft.chapters.map(chapter=>chapter.number)).toEqual([1,2]);
  expect(checkpoints).toEqual([[],[1],[1,2]]);
  expect(codex.turns.map(turn=>turn.thread.dynamicTools[0].name)).toEqual(['submit_short_revision_chapter','submit_short_revision_chapter','submit_short_revision_chapter']);
  expect(JSON.parse(codex.toolResponses[0].response.contentItems[0].text)).toMatchObject({code:'SHORT_CHAPTER_TOO_LONG',maxChapterLength:10,chapters:[{number:1,length:20}]});
  expect(draft.chapters.map(chapter=>chapter.charCount)).toEqual([6,6]);
});

it('requests only prose when keeping choices and retains option regeneration as a separate operation',async()=>{
  const {PlayTurnAgent}=await import('../play/play-agents.js');
  const codex=new CodexFixture(({thread})=>({calls:[{name:'submit_play_scene',args:{sceneText:'The player waits by the gate.',...(thread.dynamicTools[0].inputSchema.properties.suggestedActions?{suggestedActions:['Advance','Watch']}:{})}}]}));
  createCodexClient.mockImplementation(codex.createClient);
  const agent=new PlayTurnAgent({client:fixtureClient(),model:'fixture',projectRoot:'/tmp'}),input={turn:1,input:'Wait',context:'A player at a gate.',mode:'guided' as const,language:'en' as const,choiceCount:2};
  const original=['Keep waiting','Leave'];
  expect((await agent.renderExisting({...input,currentSuggestedActions:original})).suggestedActions).toEqual(original);
  expect((await agent.renderExisting(input)).suggestedActions).toEqual(['Advance','Watch']);
  expect(codex.turns.map(turn=>Object.keys(turn.thread.dynamicTools[0].inputSchema.properties).sort())).toEqual([['sceneText'],['sceneText','suggestedActions']]);
});
