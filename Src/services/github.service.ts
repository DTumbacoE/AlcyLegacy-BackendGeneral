import crypto from "crypto";
import { pool } from "../config/database.js";
import { env } from "../config/env.js";

// =========================================================
// Tipos
// =========================================================

interface GitHubTokenResponse {
    access_token?: string;
    token_type?: string;
    scope?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    error?: string;
    error_description?: string;
}

interface GitHubUser {
    id: number;
    login: string;
    avatar_url?: string;
    html_url?: string;
    name?: string | null;
}

interface SaveGitHubConnectionInput {
    userId: string;
    githubId: string;
    githubUsername: string;
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    refreshTokenExpiresIn?: number;
}

// =========================================================
// Configuración
// =========================================================

const GITHUB_AUTHORIZE_URL =
    "https://github.com/login/oauth/authorize";

const GITHUB_TOKEN_URL =
    "https://github.com/login/oauth/access_token";

const GITHUB_API_URL =
    "https://api.github.com";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";

const encryptionKey = Buffer.from(
    env.GITHUB_TOKEN_ENCRYPTION_KEY,
    "hex"
);

// =========================================================
// URL de autorización
// =========================================================

export function generateGitHubAuthorizationUrl(
  state: string
): string {
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: env.GITHUB_CALLBACK_URL,
    state,
  });

  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}
// =========================================================
// Intercambiar code por token
// =========================================================

export async function exchangeGitHubCode(
    code: string
): Promise<GitHubTokenResponse> {
    const response = await fetch(GITHUB_TOKEN_URL, {
        method: "POST",

        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
        },

        body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: env.GITHUB_CALLBACK_URL,
        }),
    });

    if (!response.ok) {
        throw new Error(
            `GitHub rechazó el intercambio del código: HTTP ${response.status}`
        );
    }

    const data =
        (await response.json()) as GitHubTokenResponse;

    if (data.error) {
        throw new Error(
            data.error_description ||
            `GitHub OAuth error: ${data.error}`
        );
    }

    if (!data.access_token) {
        throw new Error(
            "GitHub no devolvió un access token."
        );
    }

    return data;
}

// =========================================================
// Obtener usuario autenticado de GitHub
// =========================================================

export async function getGitHubUser(
    accessToken: string
): Promise<GitHubUser> {
    const response = await fetch(
        `${GITHUB_API_URL}/user`,
        {
            method: "GET",

            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${accessToken}`,
                "X-GitHub-Api-Version": "2026-03-10",
                "User-Agent": "Alcy-Legacy",
            },
        }
    );

    if (!response.ok) {
        throw new Error(
            `No se pudo obtener el usuario de GitHub: HTTP ${response.status}`
        );
    }

    const user =
        (await response.json()) as GitHubUser;

    if (!user.id || !user.login) {
        throw new Error(
            "GitHub devolvió información de usuario incompleta."
        );
    }

    return user;
}

// =========================================================
// Cifrado AES-256-GCM
// =========================================================

export function encryptGitHubToken(
    token: string
): string {
    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv(
        ENCRYPTION_ALGORITHM,
        encryptionKey,
        iv
    );

    const encrypted = Buffer.concat([
        cipher.update(token, "utf8"),
        cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return [
        iv.toString("hex"),
        authTag.toString("hex"),
        encrypted.toString("hex"),
    ].join(":");
}

// =========================================================
// Descifrado
// Lo necesitaremos después para crear branches/commits/PRs.
// =========================================================

export function decryptGitHubToken(
    encryptedToken: string
): string {
    const parts = encryptedToken.split(":");

    if (parts.length !== 3) {
        throw new Error(
            "El token cifrado de GitHub tiene un formato inválido."
        );
    }

    const [ivHex, authTagHex, encryptedHex] =
        parts;

    if (
        !ivHex ||
        !authTagHex ||
        !encryptedHex
    ) {
        throw new Error(
            "El token cifrado de GitHub está incompleto."
        );
    }

    const decipher = crypto.createDecipheriv(
        ENCRYPTION_ALGORITHM,
        encryptionKey,
        Buffer.from(ivHex, "hex")
    );

    decipher.setAuthTag(
        Buffer.from(authTagHex, "hex")
    );

    const decrypted = Buffer.concat([
        decipher.update(
            Buffer.from(encryptedHex, "hex")
        ),
        decipher.final(),
    ]);

    return decrypted.toString("utf8");
}

// =========================================================
// Guardar / actualizar conexión
// =========================================================

export async function saveGitHubConnection(
    input: SaveGitHubConnectionInput
): Promise<void> {
    const {
        userId,
        githubId,
        githubUsername,
        accessToken,
        refreshToken,
        expiresIn,
        refreshTokenExpiresIn,
    } = input;

    const encryptedAccessToken =
        encryptGitHubToken(accessToken);

    const encryptedRefreshToken =
        refreshToken
            ? encryptGitHubToken(refreshToken)
            : null;

    const accessTokenExpiresAt =
        expiresIn !== undefined
            ? new Date(
                Date.now() + expiresIn * 1000
            )
            : null;

    const refreshTokenExpiresAt =
        refreshTokenExpiresIn !== undefined
            ? new Date(
                Date.now() +
                refreshTokenExpiresIn * 1000
            )
            : null;

    await pool.query(
        `
      INSERT INTO github_connections (
        id,
        user_id,
        github_id,
        github_username,
        access_token_encrypted,
        refresh_token_encrypted,
        access_token_expires_at,
        refresh_token_expires_at,
        connected_at,
        updated_at
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        NOW(),
        NOW()
      )

      ON CONFLICT (user_id)

      DO UPDATE SET
        github_id = EXCLUDED.github_id,
        github_username =
          EXCLUDED.github_username,
        access_token_encrypted =
          EXCLUDED.access_token_encrypted,
        refresh_token_encrypted =
          EXCLUDED.refresh_token_encrypted,
        access_token_expires_at =
          EXCLUDED.access_token_expires_at,
        refresh_token_expires_at =
          EXCLUDED.refresh_token_expires_at,
        updated_at = NOW()
    `,
        [
            userId,
            githubId,
            githubUsername,
            encryptedAccessToken,
            encryptedRefreshToken,
            accessTokenExpiresAt,
            refreshTokenExpiresAt,
        ]
    );
}

// =========================================================
// Consultar estado de conexión
// Nunca devolvemos tokens.
// =========================================================

export async function getGitHubConnection(
    userId: string
) {
    const result = await pool.query<{
        github_id: string;
        github_username: string;
        connected_at: Date;
        updated_at: Date;
    }>(
        `
      SELECT
        github_id,
        github_username,
        connected_at,
        updated_at
      FROM github_connections
      WHERE user_id = $1
      LIMIT 1
    `,
        [userId]
    );

    return result.rows[0] ?? null;
}

// =========================================================
// Eliminar conexión
// =========================================================

export async function deleteGitHubConnection(
    userId: string
): Promise<boolean> {
    const result = await pool.query(
        `
      DELETE FROM github_connections
      WHERE user_id = $1
    `,
        [userId]
    );

    return (result.rowCount ?? 0) > 0;
}
// =========================================================
// Obtener access token válido para operaciones GitHub
// =========================================================

interface GitHubStoredCredentials {
    access_token_encrypted: string;
    refresh_token_encrypted: string | null;
    access_token_expires_at: Date | null;
    refresh_token_expires_at: Date | null;
}

interface GitHubRefreshResponse {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
}

export async function getValidGitHubAccessToken(
    userId: string
): Promise<string> {
    const result =
        await pool.query<GitHubStoredCredentials>(
            `
        SELECT
          access_token_encrypted,
          refresh_token_encrypted,
          access_token_expires_at,
          refresh_token_expires_at
        FROM github_connections
        WHERE user_id = $1
        LIMIT 1
      `,
            [userId]
        );

    const connection = result.rows[0];

    if (!connection) {
        throw new Error(
            "El usuario no tiene una cuenta de GitHub conectada."
        );
    }

    // Si GitHub no proporcionó expiración,
    // utilizamos directamente el token almacenado.
    if (!connection.access_token_expires_at) {
        return decryptGitHubToken(
            connection.access_token_encrypted
        );
    }

    const expiresAt =
        new Date(
            connection.access_token_expires_at
        ).getTime();

    // Renovamos con 5 minutos de margen.
    const refreshThreshold =
        Date.now() + 5 * 60 * 1000;

    if (expiresAt > refreshThreshold) {
        return decryptGitHubToken(
            connection.access_token_encrypted
        );
    }

    if (!connection.refresh_token_encrypted) {
        throw new Error(
            "La sesión de GitHub expiró y no existe refresh token. Conecta GitHub nuevamente."
        );
    }

    if (
        connection.refresh_token_expires_at &&
        new Date(
            connection.refresh_token_expires_at
        ).getTime() <= Date.now()
    ) {
        throw new Error(
            "La conexión con GitHub expiró. Conecta GitHub nuevamente."
        );
    }

    const refreshToken =
        decryptGitHubToken(
            connection.refresh_token_encrypted
        );

    const response = await fetch(
        "https://github.com/login/oauth/access_token",
        {
            method: "POST",

            headers: {
                Accept: "application/json",
                "Content-Type":
                    "application/x-www-form-urlencoded",
            },

            body: new URLSearchParams({
                client_id: env.GITHUB_CLIENT_ID,
                client_secret:
                    env.GITHUB_CLIENT_SECRET,

                grant_type: "refresh_token",

                refresh_token:
                    refreshToken,
            }),
        }
    );

    if (!response.ok) {
        throw new Error(
            `GitHub rechazó la renovación del token: HTTP ${response.status}`
        );
    }

    const data =
        (await response.json()) as GitHubRefreshResponse;

    if (
        data.error ||
        !data.access_token
    ) {
        throw new Error(
            data.error_description ||
            data.error ||
            "GitHub no devolvió un nuevo access token."
        );
    }

    const encryptedAccessToken =
        encryptGitHubToken(
            data.access_token
        );

    const encryptedRefreshToken =
        data.refresh_token
            ? encryptGitHubToken(
                data.refresh_token
            )
            : connection.refresh_token_encrypted;

    const newAccessExpiration =
        data.expires_in !== undefined
            ? new Date(
                Date.now() +
                data.expires_in * 1000
            )
            : null;

    const newRefreshExpiration =
        data.refresh_token_expires_in !== undefined
            ? new Date(
                Date.now() +
                data.refresh_token_expires_in *
                1000
            )
            : connection.refresh_token_expires_at;

    await pool.query(
        `
      UPDATE github_connections
      SET
        access_token_encrypted = $1,
        refresh_token_encrypted = $2,
        access_token_expires_at = $3,
        refresh_token_expires_at = $4,
        updated_at = NOW()
      WHERE user_id = $5
    `,
        [
            encryptedAccessToken,
            encryptedRefreshToken,
            newAccessExpiration,
            newRefreshExpiration,
            userId,
        ]
    );

    return data.access_token;
}
// =========================================================
// Tipos para operaciones de repositorio
// =========================================================

interface GitHubRepositoryInfo {
    full_name: string;
    default_branch: string;

    permissions?: {
        push?: boolean;
    };
}

interface GitHubBranchInfo {
    object: {
        sha: string;
    };
}

interface GitHubFileInfo {
    sha: string;
}

interface GitHubPullRequestInfo {
    number: number;
    html_url: string;
    state: string;
}

// =========================================================
// Request autenticado a GitHub API
// =========================================================

async function githubApiRequest<T>(
    accessToken: string,
    endpoint: string,
    options: RequestInit = {}
): Promise<T> {
    const response = await fetch(
        `https://api.github.com${endpoint}`,
        {
            ...options,

            headers: {
                Accept: "application/vnd.github+json",

                Authorization:
                    `Bearer ${accessToken}`,

                "X-GitHub-Api-Version":
                    "2026-03-10",

                "User-Agent":
                    "Alcy-Legacy",

                ...(options.headers ?? {}),
            },
        }
    );

    if (!response.ok) {
        const responseText =
            await response.text();

        throw new Error(
            `GitHub API ${response.status}: ${responseText.slice(0, 500)}`
        );
    }

    // Algunas operaciones pueden devolver 204.
    if (response.status === 204) {
        return undefined as T;
    }

    return (await response.json()) as T;
}

// =========================================================
// Obtener información del repositorio
// =========================================================

export async function getGitHubRepository(
    accessToken: string,
    owner: string,
    repo: string
): Promise<GitHubRepositoryInfo> {
    return githubApiRequest<GitHubRepositoryInfo>(
        accessToken,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    );
}

// =========================================================
// Obtener SHA de la rama base
// =========================================================

export async function getGitHubBranchSha(
    accessToken: string,
    owner: string,
    repo: string,
    branch: string
): Promise<string> {
    const result =
        await githubApiRequest<GitHubBranchInfo>(
            accessToken,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`
        );

    return result.object.sha;
}

// =========================================================
// Crear nueva rama
// =========================================================

export async function createGitHubBranch(
    accessToken: string,
    owner: string,
    repo: string,
    branchName: string,
    baseSha: string
): Promise<void> {
    await githubApiRequest(
        accessToken,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json",
            },

            body: JSON.stringify({
                ref: `refs/heads/${branchName}`,
                sha: baseSha,
            }),
        }
    );
}

// =========================================================
// Obtener archivo y SHA actual
// =========================================================

export async function getGitHubFile(
    accessToken: string,
    owner: string,
    repo: string,
    filePath: string,
    branch: string
): Promise<GitHubFileInfo> {
    const encodedPath = filePath
        .split("/")
        .map(encodeURIComponent)
        .join("/");

    return githubApiRequest<GitHubFileInfo>(
        accessToken,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`
    );
}

// =========================================================
// Actualizar archivo en la nueva rama
// =========================================================

export async function updateGitHubFile(
    accessToken: string,
    owner: string,
    repo: string,
    filePath: string,
    branch: string,
    currentFileSha: string,
    refactoredCode: string
): Promise<void> {
    const encodedPath = filePath
        .split("/")
        .map(encodeURIComponent)
        .join("/");

    const content = Buffer.from(
        refactoredCode,
        "utf8"
    ).toString("base64");

    await githubApiRequest(
        accessToken,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`,
        {
            method: "PUT",

            headers: {
                "Content-Type": "application/json",
            },

            body: JSON.stringify({
                message:
                    `refactor: update ${filePath} with Alcy Legacy`,

                content,

                sha: currentFileSha,

                branch,
            }),
        }
    );
}

// =========================================================
// Crear Pull Request
// =========================================================

export async function createGitHubPullRequest(
    accessToken: string,
    owner: string,
    repo: string,
    branchName: string,
    baseBranch: string,
    filePath: string,
    headOwner?: string
): Promise<GitHubPullRequestInfo> {

    // Si la rama está en un fork:
    // DTumbacoE:nombre-rama
    //
    // Si está en el mismo repositorio:
    // nombre-rama
    const head =
        headOwner && headOwner !== owner
            ? `${headOwner}:${branchName}`
            : branchName;

    return githubApiRequest<GitHubPullRequestInfo>(
        accessToken,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json",
            },

            body: JSON.stringify({
                title:
                    `Refactor ${filePath} with Alcy Legacy`,

                head,

                base: baseBranch,

                body:
                    "Refactor generated through the Alcy Legacy workflow. Review the proposed changes before merging.",
            }),
        }
    );
}
export interface GitHubForkInfo {
    id: number;
    full_name: string;
    owner: {
        login: string;
    };
    default_branch: string;
}

export async function createGitHubFork(
    accessToken: string,
    owner: string,
    repo: string
): Promise<GitHubForkInfo> {
    return githubApiRequest<GitHubForkInfo>(
        accessToken,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/forks`,
        {
            method: "POST",
            body: JSON.stringify({})
        }
    );
}
export async function waitForGitHubFork(
    accessToken: string,
    owner: string,
    repo: string,
    maxAttempts: number = 10,
    delayMs: number = 2000
): Promise<GitHubRepositoryInfo> {

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const repository = await getGitHubRepository(
                accessToken,
                owner,
                repo
            );

            return repository;

        } catch (error) {

            if (attempt === maxAttempts) {
                throw new Error(
                    `El fork ${owner}/${repo} no estuvo disponible después de ${maxAttempts} intentos.`
                );
            }

            await new Promise(resolve =>
                setTimeout(resolve, delayMs)
            );
        }
    }

    throw new Error("No se pudo comprobar el fork de GitHub.");
}