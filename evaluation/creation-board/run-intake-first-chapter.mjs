import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const [cliPath, fixturePath, reportPath] = process.argv.slice(2);
if (!cliPath || !fixturePath || !reportPath) throw Error('Use the guarded shell entry, not this module directly');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const root = process.cwd(), coreRoot = resolve(dirname(cliPath), '../../core/dist');
const core = await import(pathToFileURL(join(coreRoot,'index.js')).href);
const { CreationTaskCoordinator } = await import(pathToFileURL(join(coreRoot,'creation/coordinator.js')).href);
const { AutonomousChapterRunner } = await import(pathToFileURL(join(coreRoot,'pipeline/autonomous-chapters.js')).href);
const { withUnboundedWorkerExecution } = await import(pathToFileURL(join(coreRoot,'agent/worker-execution-policy.js')).href);
const { loadConfig, buildPipelineConfig } = await import(pathToFileURL(join(dirname(cliPath),'utils.js')).href);
const config = await loadConfig({requireApiKey:false});
const pipeline = new core.PipelineRunner(buildPipelineConfig(config,root,{quiet:true}));
const scheduler = new core.SchedulerStore(join(root,'.inkos/harness.sqlite'));
const coordinator = new CreationTaskCoordinator(root,pipeline,scheduler,1000);
const controller = new AbortController();
const stop = () => controller.abort(new Error('Evaluation stopped by executor'));
process.once('SIGINT',stop);process.once('SIGTERM',stop);
const report = {fixture:fixture.id,startedAt:new Date().toISOString(),model:'gpt-6.1-sol',reasoningEffort:'ultra',serviceTier:'priority',publicationTested:false,syntheticPublisherUsed:false,scope:'real product semantic planner, foundation and first-chapter review; no UI/HTTP or remote publication claim'};
async function save(){await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');}
try {
  // These are evaluation defaults only. The two creative inputs remain kind and brief.
  const request = {id:randomUUID(),kind:fixture.kind,brief:fixture.brief};
  const defaults = core.inferCreationPlan(request,{language:fixture.provisionalLanguage,daemon:{market:{platform:'other',language:fixture.provisionalLanguage}}});
  let task = coordinator.tasks.create(request,defaults);
  Object.assign(report,{taskId:task.id,workId:task.workId,provisionalPlan:task.plan});await save();
  await withUnboundedWorkerExecution(()=>coordinator.prepare(task.id,controller.signal));
  task=coordinator.tasks.get(task.id);
  Object.assign(report,{plan:task.plan,planStatus:task.planStatus,endingIntent:task.endingIntent,planSummary:task.planSummary,foundation:task.foundation,error:task.error});await save();
  if(task.foundation!=='completed')throw Error('Foundation was not completed; retained state is recorded, no automatic restart');
  const mismatches=Object.entries(fixture.expectedPlan).filter(([key,value])=>task.plan[key]!==value).map(([key,expected])=>({key,expected,actual:task.plan[key]}));
  report.explicitPlanMismatches=mismatches;await save();
  if(mismatches.length)throw Error('Semantic intake violated an explicit fixture constraint; stop before chapter writing');
  const source=join(root,'works',task.workId,'source');
  const retainedBrief=await readFile(join(source,'story/brief.md'),'utf8');
  report.originalBriefRetained=retainedBrief.includes(fixture.brief);
  if(!report.originalBriefRetained)throw Error('Original two-field brief was not retained');
  const job=scheduler.reserve(task.workId,1,Date.now(),1);
  if(!job)throw Error('First chapter reservation missing');
  // Deliberately omit publisher: the actual product chapter runner ends locally
  // after its review receipt. No mock adapter manufactures a publication receipt.
  const runner=new AutonomousChapterRunner(root,pipeline,scheduler,{
    retryDelayMs:1000,persistentTransientRetries:true,writingDeadline:'none',writingAttemptsPerBatch:1,
    requireStoryClosure:(workId,chapter)=>coordinator.tasks.forWork(workId)?.plan.targetChapters===chapter,
    chapterIntent:(workId,chapter)=>coordinator.intent(workId,chapter),
    shouldContinue:workId=>coordinator.runnable(workId),
  });
  const outcome=await withUnboundedWorkerExecution(()=>runner.run(job,controller.signal));
  Object.assign(report,{chapterPhase:outcome.phase,reviewReceipt:outcome.reviewReceipt,error:outcome.error,publication:outcome.publication??null,sourceDirectory:source,semanticChecks:fixture.semanticChecks});
  if(outcome.publication)throw Error('Unexpected publication state in a no-publisher evaluation');
  report.status=outcome.reviewReceipt?'first-chapter-reviewed-awaiting-independent-semantic-reading':'retained-before-first-review-completion';
  if(!outcome.reviewReceipt)process.exitCode=2;
} catch(error){report.status='stopped-with-retained-evidence';report.failure=String(error);process.exitCode=2;}
finally{report.finishedAt=new Date().toISOString();await save();coordinator.close();scheduler.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
