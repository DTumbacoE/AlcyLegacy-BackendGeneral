import "dotenv/config";

import app from "./app.js";
import { env } from "./config/env.js";
import {
  pool,
  testDatabaseConnection,
} from "./config/database.js";

async function startServer() {
  try {
    // 1. Comprobar conexión con PostgreSQL
    await testDatabaseConnection();

    // 2. Iniciar API solamente si PostgreSQL está disponible
    const server = app.listen(env.PORT, "0.0.0.0", () => {
      console.log(
        `🚀 Legacy Guardian API ejecutándose en puerto ${env.PORT}`
      );
    });

    // Cierre controlado del servidor
    const shutdown = (signal: string) => {
      console.log(`\n${signal} recibido. Cerrando servidor...`);

      server.close(async () => {
        try {
          // Cerrar conexiones PostgreSQL
          await pool.end();

          console.log("✅ Conexión PostgreSQL cerrada.");
          console.log("✅ Servidor cerrado correctamente.");

          process.exit(0);
        } catch (error) {
          console.error("❌ Error cerrando PostgreSQL:", error);
          process.exit(1);
        }
      });
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (error) {
    console.error("❌ No se pudo iniciar API_E.");
    console.error("❌ Error conectando con PostgreSQL:");
    console.error(error);

    await pool.end().catch(() => {});

    process.exit(1);
  }
}

startServer();