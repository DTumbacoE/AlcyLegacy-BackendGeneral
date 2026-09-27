import express from "express";
import helmet from "helmet";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import jobRoutes from "./routes/job.routes.js";
import { env } from "./config/env.js";
import healthRoutes from "./routes/health.routes.js";
import authRoutes from "./routes/auth.routes.js";
import repositoryRoutes from "./routes/repository.routes.js";
import bobRoutes from "./routes/bob.routes.js";
import githubRoutes from "./routes/github.routes.js";
const app = express();

app.disable("x-powered-by");

app.use(helmet());

app.use(
  cors({
    origin: env.FRONTEND_URL,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,

  message: {
    success: false,
    error: "Demasiadas solicitudes. Intenta nuevamente más tarde.",
  },
});

app.use("/api", apiLimiter);

app.use(
  express.json({
    limit: "100kb",
  })
);

app.use(
  express.urlencoded({
    extended: false,
    limit: "100kb",
  })
);



// Health
app.use("/api/v1/health", healthRoutes);

// Autenticación
app.use("/api/v1/auth", authRoutes);

app.use("/api/v1/repositories",repositoryRoutes);

app.use("/api/v1/jobs",jobRoutes);

app.use("/api/v1/bob", bobRoutes);

app.use("/api/v1/github", githubRoutes);
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: "Recurso no encontrado",
  });
});

export default app;