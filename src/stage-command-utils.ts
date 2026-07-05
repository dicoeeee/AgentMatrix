import { createHash } from "node:crypto";
import { execFile, type ExecFileException } from "node:child_process";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WorkspaceSnapshotEntry {
  hash: string;
}

export type WorkspaceSnapshot = Map<string, WorkspaceSnapshotEntry>;

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_BUFFER = 10 * 1024 * 1024;

export async function runCommand(
  argv: string[],
  cwd: string,
  projectRoot: string,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS
): Promise<CommandResult> {
  const [executable, ...args] = argv;

  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_COMMAND_BUFFER,
        env: {
          ...process.env,
          CI: process.env.CI ?? "true",
          PATH: commandPath(projectRoot)
        }
      },
      (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
        resolve({
          exitCode: exitCodeFromError(error),
          stdout: stringifyOutput(stdout),
          stderr: stringifyOutput(stderr || error?.message || "")
        });
      }
    );
  });
}

export async function createIsolatedWorkspace(
  projectRoot: string,
  prefix: string,
  ignoredDirectories: Set<string>,
  options: { linkNodeModules?: boolean } = {}
) {
  const isolatedRoot = path.join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(isolatedRoot, { recursive: true });
  await copyWorkspace(projectRoot, isolatedRoot, ignoredDirectories);
  if (options.linkNodeModules) {
    await linkDirectoryIfPresent(projectRoot, isolatedRoot, "node_modules");
  }
  return isolatedRoot;
}

export async function readPackageScripts(projectRoot: string): Promise<Record<string, string>> {
  try {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")) as unknown;
    if (!isRecord(packageJson) || !isRecord(packageJson.scripts)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(packageJson.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return {};
    }
    throw error;
  }
}

export async function snapshotWorkspace(
  projectRoot: string,
  ignoredDirectories: Set<string>
): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = new Map();

  for (const relativePath of await listProjectFiles(projectRoot, ignoredDirectories)) {
    const content = await readFile(path.join(projectRoot, relativePath));
    snapshot.set(relativePath, {
      hash: createHash("sha256").update(content).digest("hex")
    });
  }

  return snapshot;
}

export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((relativePath) => before.get(relativePath)?.hash !== after.get(relativePath)?.hash).sort();
}

export async function listProjectFiles(projectRoot: string, ignoredDirectories: Set<string>) {
  const files: string[] = [];

  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await visit(path.join(directory, entry.name));
        }
        continue;
      }

      if (entry.isFile()) {
        files.push(path.relative(projectRoot, path.join(directory, entry.name)).split(path.sep).join("/"));
      }
    }
  }

  await visit(projectRoot);
  return files.sort();
}

export async function readMakeTargets(projectRoot: string): Promise<Set<string>> {
  for (const fileName of ["Makefile", "makefile", "GNUmakefile"]) {
    try {
      return parseMakeTargets(await readFile(path.join(projectRoot, fileName), "utf8"));
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
  }

  return new Set();
}

export async function readMakeTargetRecipes(projectRoot: string): Promise<Map<string, string>> {
  for (const fileName of ["Makefile", "makefile", "GNUmakefile"]) {
    try {
      return parseMakeTargetRecipes(await readFile(path.join(projectRoot, fileName), "utf8"));
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
  }

  return new Map();
}

async function copyWorkspace(
  sourceRoot: string,
  targetRoot: string,
  ignoredDirectories: Set<string>,
  currentDirectory = sourceRoot
) {
  const entries = await readdir(currentDirectory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        await copyWorkspace(sourceRoot, targetRoot, ignoredDirectories, path.join(currentDirectory, entry.name));
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const sourcePath = path.join(currentDirectory, entry.name);
    const targetPath = path.join(targetRoot, path.relative(sourceRoot, sourcePath));
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, await readFile(sourcePath));
  }
}

function parseMakeTargets(source: string) {
  return new Set(parseMakeTargetRecipes(source).keys());
}

function parseMakeTargetRecipes(source: string) {
  const recipes = new Map<string, string>();
  const lines = source.split(/\r?\n/);
  let currentTargets: string[] = [];

  for (const line of lines) {
    const targetMatch = /^([A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+)*)\s*:(?![=])/.exec(line);
    if (targetMatch) {
      currentTargets = targetMatch[1].trim().split(/\s+/);
      for (const target of currentTargets) {
        recipes.set(target, "");
      }
      continue;
    }

    if (/^\s/.test(line) && currentTargets.length > 0) {
      for (const target of currentTargets) {
        recipes.set(target, [recipes.get(target), line.trim()].filter(Boolean).join("\n"));
      }
      continue;
    }

    if (line.trim().length > 0) {
      currentTargets = [];
    }
  }

  return recipes;
}

async function linkDirectoryIfPresent(projectRoot: string, isolatedRoot: string, directoryName: string) {
  const source = path.join(projectRoot, directoryName);
  const target = path.join(isolatedRoot, directoryName);

  try {
    await symlink(source, target, "dir");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "EEXIST")) {
      return;
    }
    throw error;
  }
}

function commandPath(projectRoot: string) {
  return [path.join(projectRoot, "node_modules", ".bin"), process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
}

function exitCodeFromError(error: ExecFileException | null) {
  if (!error) {
    return 0;
  }

  return typeof error.code === "number" ? error.code : 1;
}

function stringifyOutput(output: string | Buffer) {
  return Buffer.isBuffer(output) ? output.toString("utf8") : output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
