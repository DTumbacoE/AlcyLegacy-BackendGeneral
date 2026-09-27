import type { Request, Response } from "express";
import jwt from "jsonwebtoken";

import { env } from "../config/env.js";

import {
  generateGitHubAuthorizationUrl,
  exchangeGitHubCode,
  getGitHubUser,
  saveGitHubConnection,
  getGitHubConnection,
  deleteGitHubConnection,
} from "../services/github.service.js";

// =========================================================
// Tipos
// =========================================================

interface GitHubStatePayload {
  userId: string;
  purpose: "github_connect";
}

// =========================================================
// GET /api/v1/github/connect
// =========================================================

export async function githubConnect(
  req: Request,
  res: Response
) {
  try {
    if (!req.user?.id) {
      return res.status(401).json({
        success: false,
        error: "Autenticación requerida",
      });
    }

    // State firmado y de corta duración.
    // Nos permite comprobar quién inició la conexión.
    const state = jwt.sign(
      {
        userId: req.user.id,
        purpose: "github_connect",
      },
      env.JWT_SECRET,
      {
        expiresIn: "10m",
      }
    );

    const authorizationUrl =
      generateGitHubAuthorizationUrl(state);

    return res.status(200).json({
      success: true,
      authorizationUrl,
    });
  } catch (error) {
    console.error(
      "Error iniciando conexión con GitHub:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        "No se pudo iniciar la conexión con GitHub",
    });
  }
}

// =========================================================
// GET /api/v1/github/callback
// =========================================================

export async function githubCallback(
  req: Request,
  res: Response
) {
  try {
    const code =
      typeof req.query.code === "string"
        ? req.query.code
        : null;

    const state =
      typeof req.query.state === "string"
        ? req.query.state
        : null;

    if (!code || !state) {
      return res.status(400).json({
        success: false,
        error:
          "GitHub no devolvió los parámetros requeridos",
      });
    }

    // =============================================
    // Validar state
    // =============================================

    let statePayload: GitHubStatePayload;

    try {
      statePayload = jwt.verify(
        state,
        env.JWT_SECRET
      ) as GitHubStatePayload;
    } catch {
      return res.status(400).json({
        success: false,
        error:
          "El estado de autorización de GitHub es inválido o expiró",
      });
    }

    if (
      !statePayload.userId ||
      statePayload.purpose !== "github_connect"
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Estado de autorización de GitHub inválido",
      });
    }

    // =============================================
    // Intercambiar code por token
    // =============================================

    const tokenData =
      await exchangeGitHubCode(code);

    if (!tokenData.access_token) {
      throw new Error(
        "GitHub no devolvió access_token"
      );
    }

    // =============================================
    // Obtener usuario GitHub
    // =============================================

    const githubUser =
      await getGitHubUser(
        tokenData.access_token
      );

    // =============================================
    // Guardar conexión cifrada
    // =============================================

    await saveGitHubConnection({
      userId: statePayload.userId,

      githubId:
        githubUser.id.toString(),

      githubUsername:
        githubUser.login,

      accessToken:
        tokenData.access_token,

      ...(tokenData.refresh_token
        ? {
            refreshToken:
              tokenData.refresh_token,
          }
        : {}),

      ...(tokenData.expires_in !== undefined
        ? {
            expiresIn:
              tokenData.expires_in,
          }
        : {}),

      ...(tokenData.refresh_token_expires_in !==
      undefined
        ? {
            refreshTokenExpiresIn:
              tokenData.refresh_token_expires_in,
          }
        : {}),
    });

    // =============================================
    // Volver al frontend
    // =============================================

    const redirectUrl = new URL(
      env.FRONTEND_URL
    );

    redirectUrl.searchParams.set(
      "github",
      "connected"
    );

    redirectUrl.searchParams.set(
      "github_username",
      githubUser.login
    );

    return res.redirect(
      redirectUrl.toString()
    );
  } catch (error) {
    console.error(
      "Error en callback de GitHub:",
      error
    );

    // Si es posible, volver al frontend
    // indicando que ocurrió un error.

    try {
      const redirectUrl = new URL(
        env.FRONTEND_URL
      );

      redirectUrl.searchParams.set(
        "github",
        "error"
      );

      return res.redirect(
        redirectUrl.toString()
      );
    } catch {
      return res.status(500).json({
        success: false,
        error:
          "No se pudo completar la conexión con GitHub",
      });
    }
  }
}

// =========================================================
// GET /api/v1/github/status
// =========================================================

export async function githubStatus(
  req: Request,
  res: Response
) {
  try {
    if (!req.user?.id) {
      return res.status(401).json({
        success: false,
        error: "Autenticación requerida",
      });
    }

    const connection =
      await getGitHubConnection(
        req.user.id
      );

    if (!connection) {
      return res.status(200).json({
        success: true,
        connected: false,
      });
    }

    return res.status(200).json({
      success: true,
      connected: true,

      github: {
        id: connection.github_id,
        username:
          connection.github_username,
        connectedAt:
          connection.connected_at,
        updatedAt:
          connection.updated_at,
      },
    });
  } catch (error) {
    console.error(
      "Error consultando conexión GitHub:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        "No se pudo consultar la conexión con GitHub",
    });
  }
}

// =========================================================
// DELETE /api/v1/github/disconnect
// =========================================================

export async function githubDisconnect(
  req: Request,
  res: Response
) {
  try {
    if (!req.user?.id) {
      return res.status(401).json({
        success: false,
        error: "Autenticación requerida",
      });
    }

    const disconnected =
      await deleteGitHubConnection(
        req.user.id
      );

    return res.status(200).json({
      success: true,
      disconnected,
      message: disconnected
        ? "GitHub desconectado correctamente"
        : "No había una cuenta de GitHub conectada",
    });
  } catch (error) {
    console.error(
      "Error desconectando GitHub:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        "No se pudo desconectar GitHub",
    });
  }
}