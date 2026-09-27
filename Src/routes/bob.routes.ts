import { Router } from "express";

import {
  bobHealth,
  bobDirectRefactor,
} from "../controllers/bob.controller.js";

import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

/* Comprobar conexión Backend General -> BOB */
router.get(
  "/health",
  requireAuth,
  bobHealth
);

/* Refactorización directa para Archivo y Carpeta */
router.post(
  "/refactor",
  requireAuth,
  bobDirectRefactor
);

export default router;