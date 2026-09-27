import type {
    Request,
    Response,
} from "express";
import { randomUUID } from "node:crypto";
import { pool } from "../config/database.js";

// ============================================================
// TIPOS
// ============================================================

interface GitHubTreeItem {
    path: string;
    type: string;
}

interface GitHubTreeResponse {
    tree?: GitHubTreeItem[];
    truncated?: boolean;
}

interface GitHubCommitResponse {
    commit?: {
        committer?: {
            date?: string;
        };
    };
}

interface GitHubRepositoryResponse {
    id: number;
    full_name: string;
    clone_url: string;
    default_branch: string;
}

// ============================================================
// VALIDAR URL DE GITHUB
// ============================================================

function parseGitHubUrl(repositoryUrl: string) {
    try {
        const url = new URL(repositoryUrl);

        if (
            url.protocol !== "https:" ||
            url.hostname !== "github.com"
        ) {
            return null;
        }

        const parts = url.pathname
            .replace(/^\/+|\/+$/g, "")
            .split("/");

        if (parts.length !== 2) {
            return null;
        }

        const owner = parts[0];

        const repo =
            parts[1]?.replace(/\.git$/, "");

        if (!owner || !repo) {
            return null;
        }

        const validPart =
            /^[A-Za-z0-9_.-]+$/;

        if (
            !validPart.test(owner) ||
            !validPart.test(repo)
        ) {
            return null;
        }

        return {
            owner,
            repo,
        };

    } catch {
        return null;
    }
}

// ============================================================
// VALIDAR RAMA
// ============================================================

function isValidBranch(branch: string) {
    return (
        branch.length >= 1 &&
        branch.length <= 255 &&
        !branch.includes("..") &&
        !branch.startsWith("/") &&
        !branch.endsWith("/") &&
        !branch.includes("\\") &&
        !/[\s~^:?*\[]/.test(branch)
    );
}

// ============================================================
// NORMALIZAR RUTA DEL ARCHIVO
// ============================================================

function normalizeFilePath(
    filePath: string
) {
    const normalized = filePath
        .trim()
        .replace(/^\/+/, "");

    if (
        !normalized ||
        normalized.length > 1000 ||
        normalized.includes("\0") ||
        normalized
            .split("/")
            .includes("..")
    ) {
        return null;
    }

    return normalized;
}

// ============================================================
// HEADERS PARA GITHUB
// ============================================================

function githubHeaders() {
    return {
        Accept:
            "application/vnd.github+json",

        "User-Agent":
            "Alcy-Legacy",

        "X-GitHub-Api-Version":
            "2022-11-28",
    };
}

// ============================================================
// CARGAR REPOSITORIO PÚBLICO
// ============================================================

export async function loadPublicRepository(
    req: Request,
    res: Response
) {
    try {

        // ========================================================
        // DATOS RECIBIDOS
        // ========================================================

        const {
            repositoryUrl,
            branch = "main",
            filePath,
        } = req.body ?? {};

        // ========================================================
        // VALIDAR DATOS
        // ========================================================

        if (
            typeof repositoryUrl !== "string" ||
            typeof branch !== "string" ||
            typeof filePath !== "string"
        ) {
            return res.status(400).json({
                success: false,

                error:
                    "repositoryUrl, branch y filePath son obligatorios.",
            });
        }

        // ========================================================
        // VALIDAR USUARIO
        // ========================================================

        if (!req.user?.id) {
            return res.status(401).json({
                success: false,
                error:
                    "Usuario no autenticado.",
            });
        }

        // ========================================================
        // VALIDAR REPOSITORIO
        // ========================================================

        const repoInfo =
            parseGitHubUrl(
                repositoryUrl.trim()
            );

        if (!repoInfo) {
            return res.status(400).json({
                success: false,

                error:
                    "La URL debe pertenecer a un repositorio válido de GitHub.",
            });
        }

        // ========================================================
        // VALIDAR RAMA
        // ========================================================

        const cleanBranch =
            branch.trim() || "main";

        if (
            !isValidBranch(cleanBranch)
        ) {
            return res.status(400).json({
                success: false,
                error:
                    "La rama indicada no es válida.",
            });
        }

        // ========================================================
        // VALIDAR ARCHIVO
        // ========================================================

        const cleanFilePath =
            normalizeFilePath(filePath);

        if (!cleanFilePath) {
            return res.status(400).json({
                success: false,

                error:
                    "La ruta del archivo no es válida.",
            });
        }

        const {
            owner,
            repo,
        } = repoInfo;

        // ========================================================
        // 1. COMPROBAR REPOSITORIO PÚBLICO EN GITHUB
        // ========================================================

        const repositoryResponse =
            await fetch(
                `https://api.github.com/repos/${encodeURIComponent(
                    owner
                )}/${encodeURIComponent(repo)}`,
                {
                    headers:
                        githubHeaders(),
                }
            );

        // ========================================================
        // ERRORES DE GITHUB
        // ========================================================

        if (!repositoryResponse.ok) {

            if (
                repositoryResponse.status === 404
            ) {
                return res.status(404).json({
                    success: false,

                    error:
                        "El repositorio no existe o no es público.",
                });
            }

            if (
                repositoryResponse.status === 403 ||
                repositoryResponse.status === 429
            ) {
                return res.status(503).json({
                    success: false,

                    error:
                        "GitHub rechazó temporalmente la solicitud o se alcanzó el límite de peticiones.",
                });
            }

            throw new Error(
                `GitHub respondió con ${repositoryResponse.status}`
            );
        }

        // ========================================================
        // INFORMACIÓN REAL DEL REPOSITORIO
        // ========================================================

        const githubRepository: GitHubRepositoryResponse =
            await repositoryResponse.json() as GitHubRepositoryResponse;
        // ========================================================
        // 2. GUARDAR / ACTUALIZAR EN POSTGRESQL
        // ========================================================

        const repositoryId = randomUUID();

        const repositoryDbResult =
            await pool.query<{
                id: string;
            }>(
                `
      INSERT INTO repositories (
        id,
        user_id,
        github_repo_id,
        full_name,
        clone_url,
        default_branch
      )

      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6
      )

      ON CONFLICT (
        user_id,
        full_name
      )

      DO UPDATE SET
        github_repo_id = EXCLUDED.github_repo_id,
        clone_url = EXCLUDED.clone_url,
        default_branch = EXCLUDED.default_branch,
        updated_at = NOW()

      RETURNING id
    `,
                [
                    repositoryId,
                    req.user.id,
                    String(githubRepository.id),
                    githubRepository.full_name,
                    githubRepository.clone_url,
                    cleanBranch,
                ]
            );

        const savedRepository =
            repositoryDbResult.rows[0];

        if (!savedRepository) {
            throw new Error(
                "No se pudo guardar el repositorio en PostgreSQL."
            );
        }

        if (!savedRepository) {
            throw new Error(
                "No se pudo guardar el repositorio en PostgreSQL."
            );
        }

        // ========================================================
        // 3. OBTENER ARCHIVO OBJETIVO
        // ========================================================

        const rawUrl =
            `https://raw.githubusercontent.com/` +
            `${encodeURIComponent(owner)}/` +
            `${encodeURIComponent(repo)}/` +
            `${encodeURIComponent(cleanBranch)}/` +
            cleanFilePath
                .split("/")
                .map(encodeURIComponent)
                .join("/");

        const fileResponse =
            await fetch(rawUrl);

        if (!fileResponse.ok) {
            return res.status(404).json({
                success: false,

                error:
                    "No se encontró el archivo. Revisa la rama y la ruta.",
            });
        }

        const targetContent =
            await fileResponse.text();

        // ========================================================
        // LIMITAR TAMAÑO DEL ARCHIVO
        // ========================================================

        if (
            targetContent.length >
            1_000_000
        ) {
            return res.status(413).json({
                success: false,

                error:
                    "El archivo objetivo supera el tamaño permitido.",
            });
        }

        const targetName =
            cleanFilePath
                .split("/")
                .pop() ??
            cleanFilePath;

        // ========================================================
        // 4. OBTENER ÁRBOL DEL REPOSITORIO
        // ========================================================

        const treeResponse =
            await fetch(
                `https://api.github.com/repos/` +
                `${encodeURIComponent(owner)}/` +
                `${encodeURIComponent(repo)}/git/trees/` +
                `${encodeURIComponent(cleanBranch)}` +
                `?recursive=1`,
                {
                    headers:
                        githubHeaders(),
                }
            );

        let otherFiles: {
            name: string;
            path: string;
            content: string;
        }[] = [];

        // ========================================================
        // BUSCAR ARCHIVOS DE CÓDIGO RELACIONADOS
        // ========================================================

        if (treeResponse.ok) {
            const treeData =
                (await treeResponse.json()) as GitHubTreeResponse;

            const allowedExtensions =
                /\.(py|js|ts|jsx|tsx|java|rb|go|php|c|cpp|cs)$/i;

            const candidates = (treeData.tree ?? [])
                .filter(
                    (node) =>
                        node.type === "blob" &&
                        allowedExtensions.test(node.path) &&
                        node.path !== cleanFilePath
                )
                .slice(0, 25);

            // ======================================================
            // DESCARGAR ARCHIVOS ADICIONALES
            // ======================================================

            for (const node of candidates) {
                try {
                    const otherRawUrl =
                        `https://raw.githubusercontent.com/` +
                        `${encodeURIComponent(owner)}/` +
                        `${encodeURIComponent(repo)}/` +
                        `${encodeURIComponent(cleanBranch)}/` +
                        node.path
                            .split("/")
                            .map(encodeURIComponent)
                            .join("/");

                    const response =
                        await fetch(otherRawUrl);

                    if (!response.ok) {
                        continue;
                    }

                    const content =
                        await response.text();

                    // No cargar archivos secundarios demasiado grandes.
                    if (content.length > 500_000) {
                        continue;
                    }

                    otherFiles.push({
                        name:
                            node.path.split("/").pop() ??
                            node.path,

                        path: node.path,

                        content,
                    });
                } catch {
                    // Un archivo secundario no debe hacer
                    // fallar toda la carga.
                }
            }
        }

        // ========================================================
        // 5. OBTENER ÚLTIMO COMMIT DEL ARCHIVO
        // ========================================================

        let lastCommitDate: string | null = null;

        try {
            const commitsUrl =
                `https://api.github.com/repos/` +
                `${encodeURIComponent(owner)}/` +
                `${encodeURIComponent(repo)}/commits` +
                `?path=${encodeURIComponent(cleanFilePath)}` +
                `&sha=${encodeURIComponent(cleanBranch)}` +
                `&per_page=1`;

            const commitsResponse = await fetch(
                commitsUrl,
                {
                    headers: githubHeaders(),
                }
            );

            if (commitsResponse.ok) {
                const commits: GitHubCommitResponse[] =
                    await commitsResponse.json() as GitHubCommitResponse[];

                lastCommitDate =
                    commits[0]?.commit?.committer?.date ?? null;
            }
        } catch (error) {
            console.error(
                "No se pudo obtener el último commit:",
                error
            );

            lastCommitDate = null;
        }

        // ========================================================
        // 6. RESPUESTA AL FRONTEND
        // ========================================================

        return res.status(200).json({

            success: true,

            repository: {

                // ID DE NUESTRA BASE DE DATOS
                id:
                    savedRepository.id,

                // ID REAL DEL REPOSITORIO EN GITHUB
                githubRepoId:
                    String(
                        githubRepository.id
                    ),

                owner,

                repo,

                fullName:
                    githubRepository.full_name,

                branch:
                    cleanBranch,

                cloneUrl:
                    githubRepository.clone_url,

                url:
                    `https://github.com/${owner}/${repo}`,
            },

            targetFile: {
                name:
                    targetName,

                path:
                    cleanFilePath,

                content:
                    targetContent,
            },

            otherFiles,

            lastCommitDate,

            scannedFiles:
                otherFiles.length,
        });

    } catch (error) {

        console.error(
            "Error cargando repositorio público:",
            error
        );

        return res.status(500).json({
            success: false,

            error:
                "No se pudo cargar el repositorio.",
        });
    }
}