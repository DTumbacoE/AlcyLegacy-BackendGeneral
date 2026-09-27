import type {
  Request,
  Response,
  NextFunction,
} from "express";

import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

interface JwtPayload {
  id: string;
  email: string;
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const authorization = req.headers.authorization;

    // No se envió Authorization
    if (!authorization) {
      return res.status(401).json({
        success: false,
        error: "Autenticación requerida",
      });
    }

    // Formato esperado:
    // Authorization: Bearer <token>
    const [scheme, token] = authorization.split(" ");

    if (
      scheme !== "Bearer" ||
      !token ||
      token.length > 10000
    ) {
      return res.status(401).json({
        success: false,
        error: "Token de autenticación inválido",
      });
    }

    // Verificar JWT
    const decoded = jwt.verify(
      token,
      env.JWT_SECRET
    ) as JwtPayload;

    if (!decoded.id || !decoded.email) {
      return res.status(401).json({
        success: false,
        error: "Token de autenticación inválido",
      });
    }

    // Guardamos el usuario autenticado en Request
    req.user = {
      id: decoded.id,
      email: decoded.email,
    };
      
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({
        success: false,
        error: "Sesión expirada",
      });
    }

    if (error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({
        success: false,
        error: "Token de autenticación inválido",
      });
    }

    console.error(
      "Error verificando autenticación:",
      error
    );

    return res.status(500).json({
      success: false,
      error: "Error interno del servidor",
    });
  }
}