import { z } from "zod";

export const createAnalysisSchema = z
  .object({
    source_type: z.enum(["file", "folder", "github"]),

    target_name: z
      .string()
      .trim()
      .min(1, "El nombre del objetivo es obligatorio")
      .max(255, "El nombre no puede superar los 255 caracteres"),

    risk_level: z.enum(["low", "medium", "high"]),

    score: z
      .number()
      .int()
      .min(0)
      .max(100),

    has_tests: z.boolean(),

    dependents_count: z
      .number()
      .int()
      .min(0),

    age_days: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional(),

    reasons: z
      .array(z.string().trim().min(1).max(500))
      .max(50)
      .default([]),

    flagged_libs: z
      .array(z.string().trim().min(1).max(200))
      .max(100)
      .default([]),
  })
  .strict();

export type CreateAnalysisInput =
  z.infer<typeof createAnalysisSchema>;