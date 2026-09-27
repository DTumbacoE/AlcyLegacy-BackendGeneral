import { z } from "zod";

const envSchema = z.object({
  // =========================
  // Servidor
  // =========================
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce
    .number()
    .int()
    .positive()
    .max(65535)
    .default(3000),

  FRONTEND_URL: z.string().url(),

  // =========================
  // PostgreSQL - AlwaysData
  // =========================
  DB_HOST: z.string().min(1),

  DB_PORT: z.coerce
    .number()
    .int()
    .positive()
    .max(65535)
    .default(5432),

  DB_NAME: z.string().min(1),

  DB_USER: z.string().min(1),

  DB_PASSWORD: z.string().min(1),

  // =========================
  // JWT
  // =========================
  JWT_SECRET: z.string().min(32),

  JWT_EXPIRES_IN: z.string().default("24h"),

  // =========================
  // Google OAuth
  // =========================
  GOOGLE_CLIENT_ID: z
    .string()
    .min(1, "GOOGLE_CLIENT_ID es obligatorio"),

  // =========================
  // GitHub App
  // =========================
  GITHUB_CLIENT_ID: z
    .string()
    .min(1, "GITHUB_CLIENT_ID es obligatorio"),

  GITHUB_CLIENT_SECRET: z
    .string()
    .min(1, "GITHUB_CLIENT_SECRET es obligatorio"),

  GITHUB_CALLBACK_URL: z
    .string()
    .url("GITHUB_CALLBACK_URL debe ser una URL válida"),

  // =========================
  // BOB Backend AI
  // =========================
  BOB_AI_URL: z
    .string()
    .url("BOB_AI_URL debe ser una URL válida"),

  BOB_INTERNAL_SECRET: z
    .string()
    .min(1, "BOB_INTERNAL_SECRET es obligatorio"),
  GITHUB_TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(
      /^[a-fA-F0-9]{64}$/,
      "GITHUB_TOKEN_ENCRYPTION_KEY debe contener 64 caracteres hexadecimales"
    ),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error("❌ Variables de entorno inválidas:");

  console.error(
    result.error.issues.map((issue) => ({
      campo: issue.path.join("."),
      mensaje: issue.message,
    }))
  );

  process.exit(1);
}

export const env = result.data;