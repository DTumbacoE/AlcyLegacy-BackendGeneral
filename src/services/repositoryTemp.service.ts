import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function cloneRepositoryToTemp(
  cloneUrl: string,
  branch: string
): Promise<string> {

  // Solo permitimos repositorios públicos de GitHub
  const parsedUrl = new URL(cloneUrl);

  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "github.com"
  ) {
    throw new Error(
      "Solo se permiten repositorios públicos de GitHub."
    );
  }

  const tempBase = path.join(
    tmpdir(),
    "legacy-guardian-repo-"
  );

  const repoPath = await mkdtemp(tempBase);

  try {
    await execFileAsync(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--branch",
        branch,
        cloneUrl,
        repoPath,
      ],
      {
        timeout: 60000,
        windowsHide: true,
      }
    );

    return repoPath;

  } catch (error) {

    await rm(repoPath, {
      recursive: true,
      force: true,
    });

    throw error;
  }
}

export async function removeTempRepository(
  repoPath: string
): Promise<void> {

  await rm(repoPath, {
    recursive: true,
    force: true,
  });
}