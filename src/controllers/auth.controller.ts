import type { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { OAuth2Client } from "google-auth-library";

import { pool } from "../config/database.js";
import { env } from "../config/env.js";
import {
  registerSchema,
  loginSchema,
} from "../schemas/auth.schema.js";

// ============================================================
// GOOGLE
// ============================================================

const googleClient = new OAuth2Client(
  env.GOOGLE_CLIENT_ID
);

// ============================================================
// TIPOS
// ============================================================

interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string | null;
  google_sub: string | null;
  created_at: Date;
}

interface PublicUserRow {
  id: string;
  username: string;
  email: string;
  created_at: Date;
}

// ============================================================
// GENERAR JWT DE ALCY LEGACY
// ============================================================

function generateToken(user: {
  id: string;
  email: string;
}) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
    },
    env.JWT_SECRET,
    {
      expiresIn: "24h",
    }
  );
}

// ============================================================
// REGISTRO
// POST /api/v1/auth/register
// ============================================================

export async function register(req: Request, res: Response) {
  try {
    const validation = registerSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: "Datos de registro inválidos",
        details: validation.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const {
      username,
      email,
      password,
    } = validation.data;

    const existingUser = await pool.query<{ id: string }>(
      `
        SELECT id
        FROM users
        WHERE email = $1
        LIMIT 1
      `,
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: "El correo electrónico ya está registrado",
      });
    }

    const passwordHash = await bcrypt.hash(
      password,
      12
    );

    const userId = randomUUID();

    const result = await pool.query<PublicUserRow>(
      `
        INSERT INTO users (
          id,
          username,
          email,
          password_hash
        )
        VALUES ($1, $2, $3, $4)
        RETURNING
          id,
          username,
          email,
          created_at
      `,
      [
        userId,
        username,
        email,
        passwordHash,
      ]
    );

    const user = result.rows[0];

    if (!user) {
      throw new Error(
        "No se pudo recuperar el usuario creado"
      );
    }

    return res.status(201).json({
      success: true,
      message: "Usuario registrado correctamente",
      user,
    });

  } catch (error) {
    console.error(
      "Error registrando usuario:",
      error
    );

    return res.status(500).json({
      success: false,
      error: "Error interno del servidor",
    });
  }
}

// ============================================================
// LOGIN NORMAL
// POST /api/v1/auth/login
// ============================================================

export async function login(req: Request, res: Response) {
  try {
    const validation = loginSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: "Datos de inicio de sesión inválidos",
        details: validation.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const {
      email,
      password,
    } = validation.data;

    const result = await pool.query<UserRow>(
      `
        SELECT
          id,
          username,
          email,
          password_hash,
          google_sub,
          created_at
        FROM users
        WHERE email = $1
        LIMIT 1
      `,
      [email]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Credenciales inválidas",
      });
    }

    // Una cuenta creada únicamente con Google
    // no posee contraseña local.
    if (!user.password_hash) {
      return res.status(401).json({
        success: false,
        error:
          "Esta cuenta utiliza inicio de sesión con Google",
      });
    }

    const validPassword = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        error: "Credenciales inválidas",
      });
    }

    const token = generateToken(user);

    return res.status(200).json({
      success: true,
      message: "Inicio de sesión correcto",
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
    });

  } catch (error) {
    console.error(
      "Error iniciando sesión:",
      error
    );

    return res.status(500).json({
      success: false,
      error: "Error interno del servidor",
    });
  }
}

// ============================================================
// LOGIN CON GOOGLE
// POST /api/v1/auth/google
// ============================================================

export async function googleLogin(
  req: Request,
  res: Response
) {
  try {
    const credential = req.body?.credential;

    if (
      typeof credential !== "string" ||
      credential.length === 0 ||
      credential.length > 10000
    ) {
      return res.status(400).json({
        success: false,
        error: "Token de Google requerido",
      });
    }

    // Verificar el ID Token directamente con Google.
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    if (!payload) {
      return res.status(401).json({
        success: false,
        error: "Token de Google inválido",
      });
    }

    const googleSub = payload.sub;
    const email = payload.email;
    const emailVerified = payload.email_verified;
    const name = payload.name;

    if (
      !googleSub ||
      !email ||
      !emailVerified
    ) {
      return res.status(401).json({
        success: false,
        error:
          "La cuenta de Google no pudo ser verificada",
      });
    }

    const normalizedEmail =
      email.trim().toLowerCase();

    // ========================================================
    // 1. Buscar primero por google_sub
    // ========================================================

    let result = await pool.query<UserRow>(
      `
        SELECT
          id,
          username,
          email,
          password_hash,
          google_sub,
          created_at
        FROM users
        WHERE google_sub = $1
        LIMIT 1
      `,
      [googleSub]
    );

    let user: UserRow | undefined = result.rows[0];

    // ========================================================
    // 2. Si no existe por Google, buscar por email
    // ========================================================

    if (!user) {
      result = await pool.query<UserRow>(
        `
          SELECT
            id,
            username,
            email,
            password_hash,
            google_sub,
            created_at
          FROM users
          WHERE email = $1
          LIMIT 1
        `,
        [normalizedEmail]
      );

      user = result.rows[0];

      // ======================================================
      // 3. El email ya existía como cuenta normal
      //    Vincular Google con esa cuenta.
      // ======================================================

      if (user) {
        // Seguridad adicional:
        // no permitir sobrescribir otro google_sub.
        if (
          user.google_sub &&
          user.google_sub !== googleSub
        ) {
          return res.status(409).json({
            success: false,
            error:
              "Esta cuenta ya está vinculada con otra cuenta de Google",
          });
        }

        const linkedResult =
          await pool.query<UserRow>(
            `
              UPDATE users
              SET
                google_sub = $1,
                updated_at = NOW()
              WHERE id = $2
              RETURNING
                id,
                username,
                email,
                password_hash,
                google_sub,
                created_at
            `,
            [
              googleSub,
              user.id,
            ]
          );

        const linkedUser = linkedResult.rows[0];

        if (!linkedUser) {
          throw new Error(
            "No se pudo recuperar el usuario vinculado con Google"
          );
        }

        user = linkedUser;
      }
    }

    // ========================================================
    // 4. Si tampoco existe por email, crear usuario
    // ========================================================

    if (!user) {
      const userId = randomUUID();

      // Google puede proporcionar el nombre.
      // Si no existe, usamos la parte anterior al @.
      const emailUsername =
        normalizedEmail.slice(
          0,
          normalizedEmail.indexOf("@")
        );

      const username =
        typeof name === "string" &&
          name.trim().length >= 3
          ? name.trim().slice(0, 100)
          : emailUsername.slice(0, 100);
      const createdResult =
        await pool.query<UserRow>(
          `
            INSERT INTO users (
              id,
              username,
              email,
              password_hash,
              google_sub
            )
            VALUES (
              $1,
              $2,
              $3,
              NULL,
              $4
            )
            RETURNING
              id,
              username,
              email,
              password_hash,
              google_sub,
              created_at
          `,
          [
            userId,
            username,
            normalizedEmail,
            googleSub,
          ]
        );

      const createdUser = createdResult.rows[0];

      if (!createdUser) {
        throw new Error(
          "No se pudo recuperar el usuario creado con Google"
        );
      }

      user = createdUser;
    }

    if (!user) {
      throw new Error(
        "No se pudo recuperar el usuario de Google"
      );
    }

    // ========================================================
    // 5. Generar NUESTRO JWT
    // ========================================================

    const token = generateToken(user);

    return res.status(200).json({
      success: true,
      message:
        "Inicio de sesión con Google correcto",
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
    });

  } catch (error) {
    console.error(
      "Error iniciando sesión con Google:",
      error
    );

    return res.status(401).json({
      success: false,
      error:
        "No se pudo autenticar con Google",
    });
  }
}

// ============================================================
// USUARIO ACTUAL
// GET /api/v1/auth/me
// ============================================================

export async function getMe(
  req: Request,
  res: Response
) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: "Autenticación requerida",
      });
    }

    const result =
      await pool.query<PublicUserRow>(
        `
          SELECT
            id,
            username,
            email,
            created_at
          FROM users
          WHERE id = $1
          LIMIT 1
        `,
        [req.user.id]
      );

    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "Usuario no encontrado",
      });
    }

    return res.status(200).json({
      success: true,
      user,
    });

  } catch (error) {
    console.error(
      "Error obteniendo usuario:",
      error
    );

    return res.status(500).json({
      success: false,
      error: "Error interno del servidor",
    });
  }
}