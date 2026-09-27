import { Pool } from "pg";
import { env } from "./env.js";

export const pool = new Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,

  // Para la conexión remota con AlwaysData
  ssl:
    env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,

  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (error) => {
  console.error("❌ Error inesperado en PostgreSQL:", error);
});

export async function testDatabaseConnection(): Promise<void> {
  const client = await pool.connect();

  try {
    const result = await client.query<{
      current_database: string;
      current_user: string;
      server_time: Date;
    }>(`
      SELECT
        current_database() AS current_database,
        current_user AS current_user,
        NOW() AS server_time
    `);

    const db = result.rows[0];

    if (!db) {
      throw new Error(
        "PostgreSQL no devolvió información de la conexión."
      );
    }

    console.log("✅ PostgreSQL conectado correctamente");
    console.log(`📦 Base de datos: ${db.current_database}`);
    console.log(`👤 Usuario: ${db.current_user}`);
    console.log(`🕐 Servidor: ${db.server_time}`);
  } finally {
    client.release();
  }
}