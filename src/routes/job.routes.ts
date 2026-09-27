import {
  Router,
} from "express";

import {
  createJob,
  analyzeJob,
  refactorJob,
  createPullRequestForJob,
} from "../controllers/job.controller.js";

import {
  requireAuth,
} from "../middleware/requireAuth.js";


const router = Router();

// POST /api/v1/jobs
// Crea un nuevo trabajo de análisis.
router.post(
  "/",
  requireAuth,
  createJob
);

// POST /api/v1/jobs/:jobId/analyze
// Ejecuta el análisis del repositorio mediante BOB.
router.post(
  "/:jobId/analyze",
  requireAuth,
  analyzeJob
);

// POST /api/v1/jobs/:jobId/refactor
// Ejecuta la refactorización del archivo mediante BOB.
router.post(
  "/:jobId/refactor",
  requireAuth,
  refactorJob
);
router.post(
  "/:jobId/pull-request",
  requireAuth,
  createPullRequestForJob
);

export default router;