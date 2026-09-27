import { Router } from "express";
import { pool } from "../config/database.js";

const router = Router();

// ============================================================
// Comprobar API
// ============================================================

router.get("/", (_req, res) => {
  res.status(200).json({
    success: true,
    status: "ok",
    message: "Legacy Guardian API funcionando",
  });
});


// ============================================================
// Comprobar conexión con PostgreSQL
// ============================================================

router.get("/database", async (_req, res) => {
  try {
    const result = await pool.query<{
      database: string;
      user: string;
      server_time: Date;
    }>(`
      SELECT
        current_database() AS database,
        current_user AS user,
        NOW() AS server_time
    `);

    const databaseInfo = result.rows[0];

    if (!databaseInfo) {
      return res.status(503).json({
        success: false,
        status: "database_unavailable",
        message: "La base de datos no respondió correctamente.",
      });
    }

    return res.status(200).json({
      success: true,
      status: "ok",
      database: "connected",
      database_name: databaseInfo.database,
      server_time: databaseInfo.server_time,
    });

  } catch (error) {
    console.error(
      "Error de conexión con PostgreSQL:",
      error
    );

    return res.status(503).json({
      success: false,
      status: "database_unavailable",
      message:
        "No se pudo establecer comunicación con PostgreSQL.",
    });
  }
});

export default router;