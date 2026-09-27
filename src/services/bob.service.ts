import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";

import { env } from "../config/env.js";


const MAX_FILES = 50;
const MAX_FILE_CHARS = 200_000;


const getBobUrl = (path: string): string => {
  const baseUrl = env.BOB_AI_URL.replace(/\/+$/, "");
  return `${baseUrl}${path}`;
};


export interface BobFileAnalysis {
  filePath: string;
  riskScore: number;
  riskLevel: "low" | "medium" | "high";
  dependencies: number;
  coverage: string;
  age: string;
  blockers: string[];
  safeToRefactorDirectly: boolean;
  recommendation: string;
}


export interface BobAnalyzeResponse {
  success: boolean;

  summary: {
    overallRisk: number;
    riskLevel: "low" | "medium" | "high";
    totalFiles: number;
    highRiskFilesCount: number;
  };

  files: BobFileAnalysis[];
}


interface AnalyzeRepositoryParams {
  repoPath: string;
  targetFiles: string[];
  scope: "file" | "folder" | "repo";
}


interface RefactorRepositoryParams {
  filePath: string;
  originalCode: string;

  userSpecs: {
    targetLanguage: string;
    targetVersion: string;
    framework: string;
    customInstructions: string;
  };

  generateTests: boolean;
  riskScore?: number;
}


interface BobAnalyzeFile {
  path: string;
  content: string;
}


export interface BobRefactorResponse {
  success: boolean;
  filePath: string;
  refactoredCode: string;
  generatedTests: string;
  diff: string;
  changesSummary: string[];
}


/**
 * Convierte una ruta a formato relativo compatible con BOB.
 *
 * Ejemplo:
 * src\services\app.ts
 *
 * se convierte en:
 *
 * src/services/app.ts
 */
function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "");
}


/**
 * Verifica que un archivo solicitado permanezca dentro de repoPath.
 *
 * Evita rutas como:
 *
 * ../../archivo.txt
 *
 * o rutas absolutas fuera del repositorio.
 */
function resolveSafeFilePath(
  repoPath: string,
  filePath: string
): {
  absolutePath: string;
  relativePath: string;
} {
  const repositoryRoot = resolve(repoPath);

  const normalizedInput = filePath.replace(/\\/g, "/");

  if (!normalizedInput.trim()) {
    throw new Error("BOB Analyze: se recibió una ruta de archivo vacía.");
  }

  if (isAbsolute(normalizedInput)) {
    throw new Error(
      `BOB Analyze: ruta absoluta no permitida: ${filePath}`
    );
  }

  const absolutePath = resolve(
    repositoryRoot,
    normalizedInput
  );

  const relativePath = relative(
    repositoryRoot,
    absolutePath
  );

  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..\\`) ||
    relativePath.startsWith("../") ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `BOB Analyze: archivo fuera del repositorio: ${filePath}`
    );
  }

  return {
    absolutePath,
    relativePath: normalizeRelativePath(relativePath),
  };
}


/**
 * Lee los archivos solicitados desde el repositorio temporal
 * del Backend General.
 *
 * El contenido se enviará por HTTPS a BOB.
 */
async function prepareFilesForBob(
  repoPath: string,
  targetFiles: string[]
): Promise<BobAnalyzeFile[]> {
  if (!Array.isArray(targetFiles) || targetFiles.length === 0) {
    throw new Error(
      "BOB Analyze: no se recibieron archivos para analizar."
    );
  }

  if (targetFiles.length > MAX_FILES) {
    throw new Error(
      `BOB Analyze: máximo ${MAX_FILES} archivos por solicitud.`
    );
  }

  const files: BobAnalyzeFile[] = [];

  for (const filePath of targetFiles) {
    const {
      absolutePath,
      relativePath,
    } = resolveSafeFilePath(
      repoPath,
      filePath
    );

    let content: string;

    try {
      content = await readFile(
        absolutePath,
        "utf8"
      );
    } catch {
      throw new Error(
        `BOB Analyze: no fue posible leer el archivo ${relativePath}.`
      );
    }

    if (content.length > MAX_FILE_CHARS) {
      throw new Error(
        `BOB Analyze: el archivo ${relativePath} supera ` +
        `el límite de ${MAX_FILE_CHARS} caracteres.`
      );
    }

    files.push({
      path: relativePath,
      content,
    });
  }

  return files;
}


/**
 * Comprueba que BOB esté disponible.
 */
export async function checkBobHealth() {
  const response = await fetch(
    getBobUrl("/internal/v1/health"),
    {
      method: "GET",

      headers: {
        "X-Internal-Secret": env.BOB_INTERNAL_SECRET,
        Accept: "application/json",
      },

      signal: AbortSignal.timeout(5000),
    }
  );

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `BOB Health respondió HTTP ${response.status}: ${body}`
    );
  }

  return response.json();
}


/**
 * Envía un repositorio/archivo a BOB para análisis.
 *
 * IMPORTANTE:
 *
 * repoPath pertenece al filesystem del Backend General.
 * No se envía esa ruta a BOB porque BOB puede estar
 * ejecutándose en otra máquina (por ejemplo Railway).
 *
 * En su lugar:
 *
 * 1. General lee targetFiles.
 * 2. General envía path + content.
 * 3. BOB reconstruye temporalmente los archivos.
 * 4. BOB ejecuta el análisis.
 */
export async function analyzeRepository(
  params: AnalyzeRepositoryParams
): Promise<BobAnalyzeResponse> {

  const files = await prepareFilesForBob(
    params.repoPath,
    params.targetFiles
  );

  const targetFiles = files.map(
    (file) => file.path
  );

  const response = await fetch(
    getBobUrl("/internal/v1/analyze"),
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Internal-Secret": env.BOB_INTERNAL_SECRET,
      },

      body: JSON.stringify({
        files,
        targetFiles,
        scope: params.scope,
      }),

      signal: AbortSignal.timeout(120000),
    }
  );

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `BOB Analyze respondió HTTP ${response.status}: ${body}`
    );
  }

  return (await response.json()) as BobAnalyzeResponse;
}


/**
 * Solicita a BOB la modernización de un archivo.
 *
 * Este endpoint ya transporta originalCode, por lo que
 * no depende de compartir el filesystem con BOB.
 */
export async function refactorRepository(
  params: RefactorRepositoryParams
): Promise<BobRefactorResponse> {

  const response = await fetch(
    getBobUrl("/internal/v1/refactor"),
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Internal-Secret": env.BOB_INTERNAL_SECRET,
      },

      body: JSON.stringify({
        filePath: params.filePath,
        originalCode: params.originalCode,

        userSpecs: {
          targetLanguage:
            params.userSpecs.targetLanguage,

          targetVersion:
            params.userSpecs.targetVersion,

          framework:
            params.userSpecs.framework,

          customInstructions:
            params.userSpecs.customInstructions,
        },

        generateTests:
          params.generateTests,

        riskScore:
          params.riskScore,
      }),

      signal: AbortSignal.timeout(120000),
    }
  );

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `BOB Refactor respondió HTTP ${response.status}: ${body}`
    );
  }

  return (await response.json()) as BobRefactorResponse;
}