import { Router } from "express";

import {
  loadPublicRepository,
} from "../controllers/repository.controller.js";

import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

// POST /api/v1/repositories/load
router.post(
  "/load",
  requireAuth,
  loadPublicRepository
);

export default router;