import { Type } from '@sinclair/typebox';
import { BaseAgent } from '../agents/base.js';
import { CreationPlanSchema, type CreationPlan, type CreationRequest } from './contracts.js';
const ResultSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 120 }), genre: Type.String({ minLength: 1, maxLength: 100 }),
  blurb: Type.String({minLength: 1, maxLength: 2000}),
  language: Type.Union([Type.Literal('zh'), Type.Literal('en')]),
  targetChapters: Type.Integer({ minimum: 1, maximum: 2000 }), chapterWordCount: Type.Integer({ minimum: 1, maximum: 20000 }),
  endingIntent: Type.String({ minLength: 1 }), summary: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

/** Semantic intake uses the existing architect context/model. The brief is the
 * authority; numeric/negation regexes never decide the committed production plan. */
export class CreationPlannerAgent extends BaseAgent {
  get name(): string { return 'architect'; }
  async plan(request: CreationRequest, defaults: CreationPlan) {
    const { result } = await this.submitStructured([
      { role: 'system', content: `Turn the author's brief into a finite, editable writing plan. This is intake planning, not prose generation.
Read the WHOLE brief semantically. Respect explicit language, total length, chapter/section count and ending preferences over defaults.
Distinguish instructions from story events, quotations, examples and negations. In a correction such as "not three chapters, five", choose five. Do not turn a negated language into the selected language.
Use defaults only for unspecified details. The brief's language alone need not be the requested writing language.
Generate a fitting original working title, genre and a concise public-facing book blurb in the selected language. The blurb is platform metadata: do not include private instructions, account details, production notes or ending spoilers; never paste the author brief verbatim as instructions. A short story may be one chapter or several sections as the brief and length warrant. A long novel needs a finite earned ending, not an endless serial or a mechanically fixed beat formula.
Explain the main conflict's intended resolution (including an explicitly requested open ending) in endingIntent. Explain assumptions and estimated length in summary. Do not change, discover or invent a publishing account, platform binding, contract or permission.
Return a complete plan through the result tool. The selected platform is locked separately by the host.` },
      { role: 'user', content: JSON.stringify({ kind: request.kind, authorBrief: request.brief, provisionalDefaults: defaults }) },
    ], {
      name: 'submit_creation_plan', label: 'Submit creation plan', description: 'Return the finite story plan inferred from the full author brief.',
      parameters: ResultSchema,
      validate: value => { const { endingIntent: _ending, summary: _summary, ...plan } = value; CreationPlanSchema.required({blurb: true}).parse({ ...plan, platform: defaults.platform }); return value; },
    }, { professionalGuidance: false });
    const { endingIntent, summary, ...plan } = result;
    return { plan: CreationPlanSchema.required({blurb: true}).parse({ ...plan, platform: defaults.platform }), endingIntent, summary };
  }
}
