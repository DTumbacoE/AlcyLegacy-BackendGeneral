import type { Request, Response } from "express";

import {
  checkBobHealth,
  refactorRepository,
} from "../services/bob.service.js";


/* =========================================================
   BOB HEALTH
   Comprueba la conexión Backend General -> Backend AI
   ========================================================= */

export const bobHealth = async (
  _req: Request,
  res: Response
): Promise<void> => {
  try {
    const bob = await checkBobHealth();

    res.status(200).json({
      success: true,
      message:
        "Backend General conectado correctamente con BOB",
      bob,
    });

  } catch (error) {
    console.error(
      "Error conectando con BOB:",
      error
    );

    res.status(502).json({
      success: false,
      message:
        "No fue posible comunicarse con Backend AI",
    });
  }
};


/* =========================================================
   BOB DIRECT REFACTOR
   Utilizado por los modos Archivo y Carpeta.

   No necesita un Job de GitHub porque el frontend envía
   directamente el contenido del archivo al Backend General.

   Frontend
      ↓
   Backend General
      ↓
   BOB /internal/v1/refactor
   ========================================================= */

export const bobDirectRefactor = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {

    const {
      filePath,
      originalCode,
      customInstructions,
      riskScore,
    } = req.body ?? {};


    /* -------------------------------------------------------
       1. Validar filePath
       ------------------------------------------------------- */

    if (
      typeof filePath !== "string" ||
      !filePath.trim()
    ) {
      res.status(400).json({
        success: false,
        error: "filePath es obligatorio.",
      });

      return;
    }


    /* -------------------------------------------------------
       2. Validar originalCode
       ------------------------------------------------------- */

    if (
      typeof originalCode !== "string" ||
      !originalCode.trim()
    ) {
      res.status(400).json({
        success: false,
        error: "originalCode es obligatorio.",
      });

      return;
    }


    /* -------------------------------------------------------
       3. Validar tamaño máximo aceptado por BOB
       ------------------------------------------------------- */

    if (originalCode.length > 50_000) {
      res.status(413).json({
        success: false,
        error:
          "El archivo supera el límite de 50 000 caracteres.",
      });

      return;
    }


    /* -------------------------------------------------------
       4. Normalizar instrucciones del usuario
       ------------------------------------------------------- */

    const instructions =
      typeof customInstructions === "string"
        ? customInstructions.trim()
        : "";

    if (instructions.length > 1_000) {
      res.status(400).json({
        success: false,
        error:
          "customInstructions no puede superar los 1000 caracteres.",
      });

      return;
    }


    /* -------------------------------------------------------
       5. Validar riskScore
       ------------------------------------------------------- */

    let normalizedRiskScore: number | undefined;

    if (
      riskScore !== undefined &&
      riskScore !== null
    ) {
      const parsedRisk = Number(riskScore);

      if (
        !Number.isFinite(parsedRisk) ||
        parsedRisk < 0 ||
        parsedRisk > 100
      ) {
        res.status(400).json({
          success: false,
          error:
            "riskScore debe ser un número entre 0 y 100.",
        });

        return;
      }

      normalizedRiskScore =
        Math.round(parsedRisk);
    }


    /* -------------------------------------------------------
       6. Enviar solicitud a BOB
       ------------------------------------------------------- */

    console.log(
      `Refactor directo solicitado: ${filePath.trim()}`
    );

    const refactor =
      await refactorRepository({
        filePath: filePath.trim(),

        originalCode,

        userSpecs: {
          targetLanguage: "python",
          targetVersion: "3.12",
          framework: "standard",
          customInstructions: instructions,
        },

        generateTests: true,

        ...(normalizedRiskScore !== undefined
          ? { riskScore: normalizedRiskScore }
          : {}),
      });


    /* -------------------------------------------------------
       7. Respuesta al frontend
       ------------------------------------------------------- */

    res.status(200).json({
      success: true,

      message:
        "Refactorización directa completada correctamente.",

      refactor,
    });

  } catch (error) {

    console.error(
      "Error en refactorización directa con BOB:",
      error
    );

    res.status(502).json({
      success: false,

      error:
        error instanceof Error
          ? error.message
          : "No fue posible completar la refactorización con BOB.",
    });
  }
};