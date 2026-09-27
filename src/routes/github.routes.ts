import { Router } from "express";

import {
  githubConnect,
  githubCallback,
  githubStatus,
  githubDisconnect,
} from "../controllers/github.controller.js";

import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

// Iniciar conexión con GitHub
router.get(
  "/connect",
  requireAuth,
  githubConnect
);

// Callback de GitHub.
// No lleva requireAuth porque GitHub redirige aquí.
// La identidad del usuario se valida mediante el state firmado.
router.get(
  "/callback",
  githubCallback
);

// Consultar si el usuario tiene GitHub conectado
router.get(
  "/status",
  requireAuth,
  githubStatus
);

// Desconectar GitHub
router.delete(
  "/disconnect",
  requireAuth,
  githubDisconnect
);

export default router;