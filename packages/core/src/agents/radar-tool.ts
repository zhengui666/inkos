import { Type } from "@sinclair/typebox";

export const RadarResultToolSchema = Type.Object({
  recommendations: Type.Array(Type.Object({
    platform: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.String({ minLength: 1 })),
    language: Type.Optional(Type.Union([Type.Literal("zh"), Type.Literal("en")])),
    evidenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    genre: Type.String(),
    concept: Type.String(),
    reasoning: Type.String(),
    benchmarkTitles: Type.Array(Type.String()),
  })),
  marketSummary: Type.String(),
});
