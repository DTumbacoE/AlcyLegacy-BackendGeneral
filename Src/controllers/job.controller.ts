import type {
  Request,
  Response,
} from "express";

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { pool } from "../config/database.js";

import {
  analyzeRepository,
  refactorRepository,
} from "../services/bob.service.js";
import {
  getValidGitHubAccessToken,
  getGitHubRepository,
  getGitHubBranchSha,
  createGitHubBranch,
  getGitHubFile,
  updateGitHubFile,
  createGitHubPullRequest,
  createGitHubFork,
  waitForGitHubFork,
  getGitHubConnection,
} from "../services/github.service.js";

import {
  cloneRepositoryToTemp,
  removeTempRepository,
} from "../services/repositoryTemp.service.js";

// ============================================================
// CREAR JOB
// ============================================================

export async function createJob(
  req: Request,
  res: Response
) {
  try {
    if (!req.user?.id) {
      return res.status(401).json({
        success: false,
        error: "Usuario no autenticado.",
      });
    }

    const {
      repositoryId,
      jobType = "GITHUB",
      userSpecifications = null,
    } = req.body ?? {};

    // ========================================================
    // VALIDACIONES
    // ========================================================

    if (
      typeof repositoryId !== "string" ||
      !repositoryId.trim()
    ) {
      return res.status(400).json({
        success: false,
        error: "repositoryId es obligatorio.",
      });
    }

    const allowedJobTypes = [
      "FILE",
      "FOLDER",
      "GITHUB",
      "DOCUMENTATION",
    ];

    if (
      typeof jobType !== "string" ||
      !allowedJobTypes.includes(jobType)
    ) {
      return res.status(400).json({
        success: false,
        error: "El tipo de trabajo no es válido.",
      });
    }

    // ========================================================
    // VERIFICAR QUE EL REPOSITORIO PERTENECE AL USUARIO
    // ========================================================

    const repositoryResult =
      await pool.query<{
        id: string;
        full_name: string;
      }>(
        `
          SELECT
            id,
            full_name
          FROM repositories
          WHERE id = $1
            AND user_id = $2
          LIMIT 1
        `,
        [
          repositoryId,
          req.user.id,
        ]
      );

    const repository =
      repositoryResult.rows[0];

    if (!repository) {
      return res.status(404).json({
        success: false,
        error:
          "El repositorio no existe o no pertenece al usuario.",
      });
    }

    // ========================================================
    // CREAR JOB
    // ========================================================

    const jobId = randomUUID();

    const jobResult =
      await pool.query(
        `
          INSERT INTO jobs (
            id,
            user_id,
            repository_id,
            job_type,
            status,
            progress_percent,
            user_specifications
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            'QUEUED',
            0,
            $5::jsonb
          )

          RETURNING
            id,
            user_id,
            repository_id,
            job_type,
            status,
            progress_percent,
            overall_risk_score,
            overall_risk_level,
            user_specifications,
            error_message,
            created_at,
            completed_at
        `,
        [
          jobId,
          req.user.id,
          repositoryId,
          jobType,
          userSpecifications === null
            ? null
            : JSON.stringify(
              userSpecifications
            ),
        ]
      );

    const job =
      jobResult.rows[0];

    // ========================================================
    // RESPUESTA
    // ========================================================

    return res.status(201).json({
      success: true,

      message:
        "Trabajo de análisis creado correctamente.",

      repository: {
        id: repository.id,
        fullName:
          repository.full_name,
      },

      job,
    });
  } catch (error) {
    console.error(
      "Error creando job:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        "No se pudo crear el trabajo de análisis.",
    });
  }
}


// ============================================================
// ANALIZAR JOB CON BOB
// ============================================================

export async function analyzeJob(
  req: Request,
  res: Response
) {
  // ==========================================================
  // VARIABLES
  // ==========================================================

  const userId =
    req.user?.id;

  const jobId =
    req.params.jobId;

  let repoPath:
    string | null = null;

  // ==========================================================
  // VALIDAR USUARIO
  // ==========================================================

  if (!userId) {
    return res.status(401).json({
      success: false,
      error:
        "Usuario no autenticado.",
    });
  }

  // ==========================================================
  // VALIDAR JOB ID
  // ==========================================================

  if (
    !jobId ||
    typeof jobId !== "string"
  ) {
    return res.status(400).json({
      success: false,
      error:
        "jobId es obligatorio.",
    });
  }

  try {
    // ========================================================
    // 1. OBTENER JOB + REPOSITORIO
    // ========================================================

    const jobResult =
      await pool.query<{
        id: string;
        repository_id: string;
        status: string;
        job_type: string;
        user_specifications:
        Record<string, unknown> | null;
        clone_url: string;
        default_branch: string;
        full_name: string;
      }>(
        `
          SELECT
            j.id,
            j.repository_id,
            j.status,
            j.job_type,
            j.user_specifications,

            r.clone_url,
            r.default_branch,
            r.full_name

          FROM jobs j

          INNER JOIN repositories r
            ON r.id = j.repository_id

          WHERE
            j.id = $1
            AND j.user_id = $2
            AND r.user_id = $2

          LIMIT 1
        `,
        [
          jobId,
          userId,
        ]
      );

    const job =
      jobResult.rows[0];

    if (!job) {
      return res.status(404).json({
        success: false,
        error:
          "El trabajo no existe o no pertenece al usuario.",
      });
    }

    // ========================================================
    // 2. VALIDAR ESTADO
    // ========================================================

    if (
      job.status === "ANALYZING" ||
      job.status === "REFACTORING"
    ) {
      return res.status(409).json({
        success: false,
        error:
          "El trabajo ya se encuentra en ejecución.",
      });
    }

    // ========================================================
    // 3. OBTENER ESPECIFICACIONES
    // ========================================================

    const specifications =
      job.user_specifications ?? {};

    const rawTargetFile =
      specifications.targetFile;

    if (
      typeof rawTargetFile !== "string" ||
      !rawTargetFile.trim()
    ) {
      return res.status(400).json({
        success: false,
        error:
          "El trabajo no contiene un archivo objetivo válido.",
      });
    }

    // Normalizar separadores para BOB.
    // Ejemplo:
    // src\main.py -> src/main.py

    const targetFile =
      rawTargetFile
        .trim()
        .replace(/\\/g, "/");

    // Evitar rutas absolutas o traversal.

    if (
      targetFile.startsWith("/") ||
      targetFile.includes("../") ||
      targetFile === ".."
    ) {
      return res.status(400).json({
        success: false,
        error:
          "La ruta del archivo objetivo no es válida.",
      });
    }

    // ========================================================
    // 4. CAMBIAR JOB -> ANALYZING
    // ========================================================

    await pool.query(
      `
        UPDATE jobs
        SET
          status = 'ANALYZING',
          progress_percent = 10,
          error_message = NULL,
          completed_at = NULL
        WHERE
          id = $1
          AND user_id = $2
      `,
      [
        jobId,
        userId,
      ]
    );

    // ========================================================
    // 5. CLONAR REPOSITORIO PÚBLICO
    // ========================================================

    repoPath =
      await cloneRepositoryToTemp(
        job.clone_url,
        job.default_branch
      );

    // ========================================================
    // 6. ACTUALIZAR PROGRESO
    // ========================================================

    await pool.query(
      `
        UPDATE jobs
        SET progress_percent = 35
        WHERE
          id = $1
          AND user_id = $2
      `,
      [
        jobId,
        userId,
      ]
    );

    // ========================================================
    // 7. ENVIAR REPOSITORIO A BOB
    // ========================================================

    const analysis =
      await analyzeRepository({
        repoPath,

        targetFiles: [
          targetFile,
        ],

        scope: "file",
      });

    // BOB devuelve `summary` y `files` de acuerdo con su
    // contrato AnalyzeResponse.

    if (
      !analysis ||
      !analysis.summary ||
      !Array.isArray(
        analysis.files
      )
    ) {
      throw new Error(
        "BOB devolvió una respuesta de análisis inválida."
      );
    }

    // ========================================================
    // 8. PROGRESO 70%
    // ========================================================

    await pool.query(
      `
        UPDATE jobs
        SET progress_percent = 70
        WHERE
          id = $1
          AND user_id = $2
      `,
      [
        jobId,
        userId,
      ]
    );

    // ========================================================
    // 9. INICIAR TRANSACCIÓN
    // ========================================================

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      // ======================================================
      // 10. BORRAR ANÁLISIS ANTERIOR DEL MISMO JOB
      // ======================================================

      await client.query(
        `
          DELETE FROM file_analyses
          WHERE job_id = $1
        `,
        [
          jobId,
        ]
      );

      // ======================================================
      // 11. GUARDAR RESULTADOS DE CADA ARCHIVO
      // ======================================================

      for (
        const file
        of analysis.files
      ) {
        await client.query(
          `
            INSERT INTO file_analyses (
              id,
              job_id,
              file_path,
              risk_score,
              risk_level,
              dependencies_count,
              coverage_percentage,
              git_age,
              blockers,
              safe_to_refactor_directly
            )

            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9::jsonb,
              $10
            )
          `,
          [
            randomUUID(),

            jobId,

            file.filePath,

            file.riskScore,

            file.riskLevel,

            file.dependencies,

            file.coverage,

            file.age,

            JSON.stringify(
              file.blockers ?? []
            ),

            file.safeToRefactorDirectly,
          ]
        );
      }

      // ======================================================
      // 12. ACTUALIZAR RESULTADO GENERAL DEL JOB
      // ======================================================

      await client.query(
        `
          UPDATE jobs
          SET
            overall_risk_score = $1,
            overall_risk_level = $2,
            progress_percent = 100,
            status = 'COMPLETED',
            completed_at = NOW(),
            error_message = NULL

          WHERE
            id = $3
            AND user_id = $4
        `,
        [
          analysis.summary
            .overallRisk,

          analysis.summary
            .riskLevel,

          jobId,

          userId,
        ]
      );

      // ======================================================
      // 13. ACTUALIZAR REPOSITORIO
      // ======================================================

      await client.query(
        `
          UPDATE repositories
          SET
            last_analyzed_at = NOW(),
            updated_at = NOW()

          WHERE
            id = $1
            AND user_id = $2
        `,
        [
          job.repository_id,
          userId,
        ]
      );

      // ======================================================
      // 14. COMMIT
      // ======================================================

      await client.query(
        "COMMIT"
      );
    } catch (transactionError) {
      // ======================================================
      // ROLLBACK
      // ======================================================

      await client.query(
        "ROLLBACK"
      );

      throw transactionError;
    } finally {
      // ======================================================
      // LIBERAR CONEXIÓN
      // ======================================================

      client.release();
    }

    // ========================================================
    // 15. RESPUESTA AL FRONTEND
    // ========================================================

    return res.status(200).json({
      success: true,

      message:
        "Análisis completado correctamente.",

      repository: {
        id:
          job.repository_id,

        fullName:
          job.full_name,
      },

      job: {
        id:
          jobId,

        status:
          "COMPLETED",

        progressPercent:
          100,

        overallRiskScore:
          analysis.summary
            .overallRisk,

        overallRiskLevel:
          analysis.summary
            .riskLevel,
      },

      analysis,
    });
  } catch (error) {
    // ========================================================
    // ERROR GENERAL
    // ========================================================

    console.error(
      "Error analizando job:",
      error
    );

    // ========================================================
    // MARCAR JOB COMO FAILED
    // ========================================================

    try {
      await pool.query(
        `
          UPDATE jobs
          SET
            status = 'FAILED',
            error_message = $1

          WHERE
            id = $2
            AND user_id = $3
        `,
        [
          "No fue posible completar el análisis.",

          jobId,

          userId,
        ]
      );
    } catch (
    databaseError
    ) {
      console.error(
        "Error actualizando el job fallido:",
        databaseError
      );
    }

    return res.status(500).json({
      success: false,

      error:
        "No fue posible completar el análisis.",
    });
  } finally {
    // ========================================================
    // 16. ELIMINAR REPOSITORIO TEMPORAL
    // ========================================================

    if (repoPath) {
      try {
        await removeTempRepository(
          repoPath
        );
      } catch (
      cleanupError
      ) {
        console.error(
          "No se pudo eliminar el repositorio temporal:",
          cleanupError
        );
      }
    }
  }
}
export async function refactorJob(
  req: Request,
  res: Response
) {
  const userId = req.user?.id;
  const jobId = req.params.jobId;

  let repoPath: string | null = null;

  // ==========================================================
  // VALIDACIONES INICIALES
  // ==========================================================

  if (!userId) {
    return res.status(401).json({
      success: false,
      error: "Usuario no autenticado.",
    });
  }

  if (!jobId || typeof jobId !== "string") {
    return res.status(400).json({
      success: false,
      error: "jobId es obligatorio.",
    });
  }

  try {
    // ========================================================
    // 1. OBTENER JOB + REPOSITORIO
    // ========================================================

    const jobResult = await pool.query<{
      id: string;
      repository_id: string;
      status: string;
      user_specifications: Record<string, unknown> | null;
      clone_url: string;
      default_branch: string;
      full_name: string;
    }>(
      `
        SELECT
          j.id,
          j.repository_id,
          j.status,
          j.user_specifications,
          r.clone_url,
          r.default_branch,
          r.full_name
        FROM jobs j
        INNER JOIN repositories r
          ON r.id = j.repository_id
        WHERE
          j.id = $1
          AND j.user_id = $2
          AND r.user_id = $2
        LIMIT 1
      `,
      [jobId, userId]
    );

    const job = jobResult.rows[0];

    if (!job) {
      return res.status(404).json({
        success: false,
        error:
          "El trabajo no existe o no pertenece al usuario.",
      });
    }

    // ========================================================
    // 2. VALIDAR ESTADO
    // ========================================================

    if (
      job.status === "ANALYZING" ||
      job.status === "REFACTORING"
    ) {
      return res.status(409).json({
        success: false,
        error:
          "El trabajo ya se encuentra en ejecución.",
      });
    }

    if (
      job.status !== "COMPLETED" &&
      job.status !== "FAILED"
    ) {
      return res.status(409).json({
        success: false,
        error:
          "El trabajo no está disponible para refactorización.",
      });
    }

    // ========================================================
    // 3. OBTENER TARGET FILE
    // ========================================================

    const specifications =
      job.user_specifications ?? {};

    const rawTargetFile =
      specifications.targetFile;

    if (
      typeof rawTargetFile !== "string" ||
      !rawTargetFile.trim()
    ) {
      return res.status(400).json({
        success: false,
        error:
          "El trabajo no contiene un archivo objetivo válido.",
      });
    }

    const targetFile =
      rawTargetFile
        .trim()
        .replace(/\\/g, "/");

    if (
      targetFile.startsWith("/") ||
      targetFile.includes("../") ||
      targetFile === ".."
    ) {
      return res.status(400).json({
        success: false,
        error:
          "La ruta del archivo objetivo no es válida.",
      });
    }

    // ========================================================
    // 4. RECUPERAR ANÁLISIS DEL ARCHIVO
    // ========================================================

    const analysisResult =
      await pool.query<{
        id: string;
        file_path: string;
        risk_score: number;
        risk_level: string;
        safe_to_refactor_directly: boolean;
      }>(
        `
          SELECT
            id,
            file_path,
            risk_score,
            risk_level,
            safe_to_refactor_directly
          FROM file_analyses
          WHERE
            job_id = $1
            AND file_path = $2
          LIMIT 1
        `,
        [
          jobId,
          targetFile,
        ]
      );

    const fileAnalysis =
      analysisResult.rows[0];

    if (!fileAnalysis) {
      return res.status(404).json({
        success: false,
        error:
          "No existe un análisis previo para el archivo objetivo.",
      });
    }

    // ========================================================
    // 5. INSTRUCCIONES DEL FRONTEND
    // ========================================================

    const body =
      req.body &&
        typeof req.body === "object"
        ? req.body
        : {};

    const customInstructions =
      typeof body.customInstructions === "string"
        ? body.customInstructions.trim()
        : "";

    if (customInstructions.length > 1000) {
      return res.status(400).json({
        success: false,
        error:
          "Las instrucciones no pueden superar los 1000 caracteres.",
      });
    }

    // ========================================================
    // 6. JOB -> REFACTORING
    // ========================================================

    await pool.query(
      `
        UPDATE jobs
        SET
          status = 'REFACTORING',
          progress_percent = 10,
          error_message = NULL,
          completed_at = NULL
        WHERE
          id = $1
          AND user_id = $2
      `,
      [
        jobId,
        userId,
      ]
    );

    // ========================================================
    // 7. CLONAR REPOSITORIO
    // ========================================================

    repoPath =
      await cloneRepositoryToTemp(
        job.clone_url,
        job.default_branch
      );

    // ========================================================
    // 8. RESOLVER ARCHIVO DE FORMA SEGURA
    // ========================================================

    const repositoryRoot =
      path.resolve(repoPath);

    const absoluteTarget =
      path.resolve(
        repositoryRoot,
        targetFile
      );

    const relativeTarget =
      path.relative(
        repositoryRoot,
        absoluteTarget
      );

    if (
      relativeTarget.startsWith("..") ||
      path.isAbsolute(relativeTarget)
    ) {
      throw new Error(
        "El archivo objetivo se encuentra fuera del repositorio."
      );
    }

    // ========================================================
    // 9. LEER CÓDIGO ORIGINAL
    // ========================================================

    const originalCode =
      await readFile(
        absoluteTarget,
        "utf8"
      );

    if (!originalCode.trim()) {
      throw new Error(
        "El archivo objetivo está vacío."
      );
    }

    // BOB actualmente limita originalCode a 50 000 caracteres.
    if (originalCode.length > 50000) {
      throw new Error(
        `El archivo objetivo contiene ${originalCode.length} caracteres y BOB admite actualmente un máximo de 50000.`
      );
    }

    // ========================================================
    // 10. PROGRESO
    // ========================================================

    await pool.query(
      `
        UPDATE jobs
        SET progress_percent = 40
        WHERE
          id = $1
          AND user_id = $2
      `,
      [
        jobId,
        userId,
      ]
    );

    // ========================================================
    // 11. ENVIAR A BOB
    // ========================================================

    const refactor =
      await refactorRepository({
        filePath: targetFile,

        originalCode,

        userSpecs: {
          targetLanguage: "python",
          targetVersion: "3.12",
          framework: "standard",
          customInstructions,
        },

        generateTests: true,

        riskScore:
          fileAnalysis.risk_score,
      });

    if (
      !refactor ||
      refactor.success !== true ||
      typeof refactor.refactoredCode !== "string"
    ) {
      throw new Error(
        "BOB devolvió una respuesta de refactorización inválida."
      );
    }

    // ========================================================
    // 12. GUARDAR RESULTADO
    // ========================================================

    const client =
      await pool.connect();

    try {
      await client.query("BEGIN");

      // ========================================================
      // GUARDAR O ACTUALIZAR RESULTADO DE REFACTORIZACIÓN
      // ========================================================
      //
      // file_analysis_id tiene una restricción UNIQUE.
      //
      // Primera refactorización:
      //   -> INSERT
      //
      // Si se vuelve a ejecutar sobre el mismo análisis:
      //   -> UPDATE
      //
      // De esta forma evitamos:
      // duplicate key value violates unique constraint
      // "uq_refactored_file_analysis"
      // ========================================================

      await client.query(
        `
      INSERT INTO refactored_files (
        id,
        job_id,
        file_analysis_id,
        file_path,
        original_code,
        refactored_code,
        generated_tests,
        diff_patch,
        changes_summary
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9::jsonb
      )

      ON CONFLICT (file_analysis_id)
      DO UPDATE SET
        job_id = EXCLUDED.job_id,
        file_path = EXCLUDED.file_path,
        original_code = EXCLUDED.original_code,
        refactored_code = EXCLUDED.refactored_code,
        generated_tests = EXCLUDED.generated_tests,
        diff_patch = EXCLUDED.diff_patch,
        changes_summary = EXCLUDED.changes_summary
    `,
        [
          randomUUID(),
          jobId,
          fileAnalysis.id,
          targetFile,
          originalCode,
          refactor.refactoredCode,
          refactor.generatedTests ?? "",
          refactor.diff ?? "",
          JSON.stringify(
            refactor.changesSummary ?? []
          ),
        ]
      );

      // ========================================================
      // MARCAR JOB COMO COMPLETADO
      // ========================================================

      await client.query(
        `
      UPDATE jobs
      SET
        status = 'COMPLETED',
        progress_percent = 100,
        completed_at = NOW(),
        error_message = NULL
      WHERE
        id = $1
        AND user_id = $2
    `,
        [
          jobId,
          userId,
        ]
      );

      await client.query("COMMIT");

    } catch (transactionError) {
      await client.query("ROLLBACK");
      throw transactionError;

    } finally {
      client.release();
    }

    // ========================================================
    // 13. RESPUESTA
    // ========================================================

    return res.status(200).json({
      success: true,

      message:
        "Refactorización completada correctamente.",

      repository: {
        id: job.repository_id,
        fullName: job.full_name,
      },

      job: {
        id: jobId,
        status: "COMPLETED",
        progressPercent: 100,
      },

      refactor: {
        filePath:
          refactor.filePath,

        refactoredCode:
          refactor.refactoredCode,

        generatedTests:
          refactor.generatedTests,

        diff:
          refactor.diff,

        changesSummary:
          refactor.changesSummary,
      },
    });
  } catch (error) {
    console.error(
      "Error refactorizando job:",
      error
    );

    try {
      await pool.query(
        `
      UPDATE jobs
      SET
        status = 'COMPLETED',
        progress_percent = 100,
        error_message = $1
      WHERE
        id = $2
        AND user_id = $3
    `,
        [
          "La refactorización falló, pero el análisis previo sigue disponible.",
          jobId,
          userId,
        ]
      );
    } catch (databaseError) {
      console.error(
        "Error restaurando el estado del job:",
        databaseError
      );
    }

    return res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "No fue posible completar la refactorización.",
    });
  } finally {
    if (repoPath) {
      try {
        await removeTempRepository(
          repoPath
        );
      } catch (cleanupError) {
        console.error(
          "Error eliminando repositorio temporal:",
          cleanupError
        );
      }
    }
  }
}
export async function createPullRequestForJob(
  req: Request,
  res: Response
) {
  const userId = req.user?.id;
  const jobId = req.params.jobId;

  if (!userId) {
    return res.status(401).json({
      success: false,
      error: "Usuario no autenticado.",
    });
  }

  if (!jobId || typeof jobId !== "string") {
    return res.status(400).json({
      success: false,
      error: "jobId es obligatorio.",
    });
  }

  try {
    // =====================================================
    // 1. Obtener job + repositorio + archivo refactorizado
    // =====================================================

    const result = await pool.query<{
      job_id: string;
      job_status: string;
      full_name: string;
      default_branch: string;
      file_path: string;
      refactored_code: string;
    }>(
      `
        SELECT
          j.id AS job_id,
          j.status AS job_status,
          r.full_name,
          r.default_branch,
          rf.file_path,
          rf.refactored_code
        FROM jobs j
        INNER JOIN repositories r
          ON r.id = j.repository_id
        INNER JOIN refactored_files rf
          ON rf.job_id = j.id
        WHERE
          j.id = $1
          AND j.user_id = $2
          AND r.user_id = $2
        LIMIT 1
      `,
      [jobId, userId]
    );

    const data = result.rows[0];

    if (!data) {
      return res.status(404).json({
        success: false,
        error:
          "No existe una refactorización para este trabajo.",
      });
    }

    if (data.job_status !== "COMPLETED") {
      return res.status(409).json({
        success: false,
        error:
          "El trabajo debe estar completado antes de crear un Pull Request.",
      });
    }

    if (!data.refactored_code?.trim()) {
      return res.status(409).json({
        success: false,
        error:
          "El trabajo no contiene código refactorizado.",
      });
    }

    // =====================================================
    // 2. Evitar más de un PR por job
    // =====================================================

    const existingPr = await pool.query<{
      github_pr_number: number;
      github_pr_url: string;
      branch_name: string;
      status: string;
    }>(
      `
        SELECT
          github_pr_number,
          github_pr_url,
          branch_name,
          status
        FROM pull_requests
        WHERE job_id = $1
        LIMIT 1
      `,
      [jobId]
    );

    if (existingPr.rows[0]) {
      return res.status(409).json({
        success: false,
        error:
          "Este trabajo ya tiene un Pull Request creado.",
        pullRequest: existingPr.rows[0],
      });
    }

    // =====================================================
    // 3. Separar owner/repository
    // =====================================================

    const repoParts = data.full_name.split("/");

    if (repoParts.length !== 2) {
      throw new Error(
        "El nombre del repositorio almacenado no es válido."
      );
    }

    const owner = repoParts[0];
    const repo = repoParts[1];

    if (!owner || !repo) {
      throw new Error(
        "No fue posible identificar owner/repository."
      );
    }

    // =====================================================
    // 4. Obtener token GitHub
    // =====================================================

    const accessToken =
      await getValidGitHubAccessToken(userId);

    // =====================================================
    // 5. Comprobar acceso al repositorio
    // =====================================================

    const githubRepository =
      await getGitHubRepository(
        accessToken,
        owner,
        repo
      );

    // =====================================================
    // 6. Determinar dónde se realizará el cambio
    // =====================================================

    const baseBranch =
      data.default_branch ||
      githubRepository.default_branch;

    let workingOwner = owner;
    let workingRepo = repo;

    // Si no podemos escribir directamente en el repositorio
    // original, creamos un fork en la cuenta conectada.
    const githubConnection =
      await getGitHubConnection(userId);

    if (!githubConnection) {
      return res.status(400).json({
        success: false,
        error: "No existe una cuenta de GitHub conectada.",
      });
    }

    const connectedGitHubUsername =
      githubConnection.github_username;

    const repositoryBelongsToConnectedUser =
      owner.toLowerCase() ===
      connectedGitHubUsername.toLowerCase();

    if (!repositoryBelongsToConnectedUser) {

      console.log(
        `Repositorio externo detectado: ${owner}/${repo}`
      );

      console.log(
        `Creando fork para: ${connectedGitHubUsername}`
      );

      const fork =
        await createGitHubFork(
          accessToken,
          owner,
          repo
        );

      workingOwner = fork.owner.login;
      workingRepo = repo;

      console.log(
        `Fork solicitado: ${workingOwner}/${workingRepo}`
      );

      await waitForGitHubFork(
        accessToken,
        workingOwner,
        workingRepo
      );

      console.log(
        `Fork disponible: ${workingOwner}/${workingRepo}`
      );

    } else if (githubRepository.permissions?.push !== true) {

      return res.status(403).json({
        success: false,
        error:
          "La cuenta de GitHub conectada no tiene permisos de escritura sobre este repositorio.",
      });
    }

    // =====================================================
    // 7. Obtener SHA de la rama base
    // =====================================================

    const baseSha =
      await getGitHubBranchSha(
        accessToken,
        workingOwner,
        workingRepo,
        baseBranch
      );

    // =====================================================
    // 8. Crear nombre único de rama
    // =====================================================

    const branchName =
      `alcy-legacy/refactor-${jobId.slice(0, 8)}-${Date.now()}`;

    await createGitHubBranch(
      accessToken,
      workingOwner,
      workingRepo,
      branchName,
      baseSha
    );

    // =====================================================
    // 8. Obtener SHA del archivo original
    // =====================================================

    const githubFile =
      await getGitHubFile(
        accessToken,
        workingOwner,
        workingRepo,
        data.file_path,
        baseBranch
      );
    // =====================================================
    // 9. Commit del código generado por BOB
    // =====================================================

    await updateGitHubFile(
      accessToken,
      workingOwner,
      workingRepo,
      data.file_path,
      branchName,
      githubFile.sha,
      data.refactored_code
    );

    // =====================================================
    // 10. Crear Pull Request
    // =====================================================

    let githubPr;

    try {
      githubPr =
        await createGitHubPullRequest(
          accessToken,
          owner,
          repo,
          branchName,
          baseBranch,
          data.file_path,
          workingOwner
        );

    } catch (error) {

      const errorMessage =
        error instanceof Error
          ? error.message
          : String(error);

      const isGitHubPermissionError =
        errorMessage.includes("GitHub API 403");

      // La refactorización ya está guardada en el fork,
      // pero la GitHub App no puede crear el PR
      // directamente sobre el repositorio original.
      if (
        isGitHubPermissionError &&
        workingOwner.toLowerCase() !== owner.toLowerCase()
      ) {

        const compareUrl =
          `https://github.com/${owner}/${repo}/compare/` +
          `${encodeURIComponent(baseBranch)}...` +
          `${encodeURIComponent(workingOwner)}:` +
          `${encodeURIComponent(branchName)}?expand=1`;

        console.log(
          `PR automático no autorizado. Compare URL: ${compareUrl}`
        );

        return res.status(200).json({
          success: true,

          message:
            "La refactorización fue aplicada correctamente al fork. GitHub requiere confirmar el Pull Request.",

          requiresGitHubConfirmation: true,

          pullRequest: {
            created: false,
            compareUrl,
            branch: branchName,
            fork: `${workingOwner}/${workingRepo}`,
            targetRepository: `${owner}/${repo}`,
            baseBranch,
          },
        });
      }

      throw error;
    }

    // =====================================================
    // 11. Guardar PR
    // =====================================================

    await pool.query(
      `
        INSERT INTO pull_requests (
          id,
          job_id,
          github_pr_number,
          github_pr_url,
          branch_name,
          status,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          NOW(),
          NOW()
        )
      `,
      [
        randomUUID(),
        jobId,
        githubPr.number,
        githubPr.html_url,
        branchName,
        githubPr.state.toUpperCase(),
      ]
    );

    // =====================================================
    // 12. Respuesta
    // =====================================================

    return res.status(201).json({
      success: true,

      message:
        "Pull Request creado correctamente.",

      pullRequest: {
        number: githubPr.number,
        url: githubPr.html_url,
        branch: branchName,
        status: githubPr.state.toUpperCase(),
      },
    });
  } catch (error) {
    console.error(
      "Error creando Pull Request:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "No fue posible crear el Pull Request.",
    });
  }
}