import { execFile, type ExecFileException } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface ChangeScopeDiffEntry {
  path: string;
  additions: number;
  deletions: number;
  source: "committed" | "staged" | "unstaged" | "untracked";
}

export interface ChangeScopeSummary {
  files_changed: number;
  additions: number;
  deletions: number;
  lines_changed: number;
  entries: ChangeScopeDiffEntry[];
}

export interface LargeChangeHint {
  is_large: boolean;
  file_threshold: number;
  line_threshold: number;
  reasons: string[];
}

export interface CheckShard {
  id: string;
  name: string;
  files: string[];
  rationale: string;
}

export interface KnownChangeScope {
  schema_version: 1;
  status: "known";
  current_branch?: string;
  default_branch?: string;
  merge_base?: string;
  files: string[];
  sources: {
    committed_files: string[];
    staged_files: string[];
    unstaged_files: string[];
    untracked_files: string[];
  };
  diff_summary: ChangeScopeSummary;
  large_change: LargeChangeHint;
  suggested_check_shards: CheckShard[];
}

export interface UnknownChangeScope {
  schema_version: 1;
  status: "unknown";
  reason: string;
  files: string[];
  sources: {
    committed_files: string[];
    staged_files: string[];
    unstaged_files: string[];
    untracked_files: string[];
  };
  diff_summary: ChangeScopeSummary;
  large_change: LargeChangeHint;
  suggested_check_shards: CheckShard[];
}

export type ChangeScope = KnownChangeScope | UnknownChangeScope;

interface DefaultBranch {
  name: string;
  ref: string;
}

const FILE_THRESHOLD = 8;
const LINE_THRESHOLD = 500;
const GIT_TIMEOUT_MS = 10_000;

export async function computeChangeScope(projectRoot: string): Promise<ChangeScope> {
  if (!(await isGitRepository(projectRoot))) {
    return unknownChangeScope("Project is not inside a git work tree.");
  }

  const currentBranch = optionalTrimmed(await git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]));
  const defaultBranch = await findDefaultBranch(projectRoot, currentBranch);
  const mergeBase =
    defaultBranch && currentBranch && defaultBranch.name !== currentBranch
      ? optionalTrimmed(await git(projectRoot, ["merge-base", "HEAD", defaultBranch.ref]))
      : undefined;

  const committedFiles = mergeBase
    ? normalizeFiles(await gitLines(projectRoot, ["diff", "--name-only", `${mergeBase}...HEAD`]))
    : [];
  const stagedFiles = normalizeFiles(await gitLines(projectRoot, ["diff", "--name-only", "--cached"]));
  const unstagedFiles = normalizeFiles(await gitLines(projectRoot, ["diff", "--name-only"]));
  const untrackedFiles = normalizeFiles(await gitLines(projectRoot, ["ls-files", "--others", "--exclude-standard"]));
  const files = uniqueSorted([...committedFiles, ...stagedFiles, ...unstagedFiles, ...untrackedFiles]);

  const entries = [
    ...(mergeBase ? parseNumstat(await gitLines(projectRoot, ["diff", "--numstat", `${mergeBase}...HEAD`]), "committed") : []),
    ...parseNumstat(await gitLines(projectRoot, ["diff", "--numstat", "--cached"]), "staged"),
    ...parseNumstat(await gitLines(projectRoot, ["diff", "--numstat"]), "unstaged"),
    ...(await untrackedEntries(projectRoot, untrackedFiles))
  ].filter((entry) => files.includes(entry.path));

  const diffSummary = summarizeDiff(files, entries);
  const largeChange = largeChangeHint(diffSummary);

  return {
    schema_version: 1,
    status: "known",
    ...(currentBranch ? { current_branch: currentBranch } : {}),
    ...(defaultBranch ? { default_branch: defaultBranch.name } : {}),
    ...(mergeBase ? { merge_base: mergeBase } : {}),
    files,
    sources: {
      committed_files: committedFiles,
      staged_files: stagedFiles,
      unstaged_files: unstagedFiles,
      untracked_files: untrackedFiles
    },
    diff_summary: diffSummary,
    large_change: largeChange,
    suggested_check_shards: largeChange.is_large ? suggestedCheckShards(files) : []
  };
}

function unknownChangeScope(reason: string): UnknownChangeScope {
  const diffSummary = summarizeDiff([], []);
  return {
    schema_version: 1,
    status: "unknown",
    reason,
    files: [],
    sources: {
      committed_files: [],
      staged_files: [],
      unstaged_files: [],
      untracked_files: []
    },
    diff_summary: diffSummary,
    large_change: largeChangeHint(diffSummary),
    suggested_check_shards: []
  };
}

async function isGitRepository(projectRoot: string) {
  const result = await git(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function findDefaultBranch(projectRoot: string, currentBranch?: string): Promise<DefaultBranch | undefined> {
  const remoteHead = optionalTrimmed(await git(projectRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]));
  if (remoteHead) {
    return {
      name: remoteHead.replace(/^origin\//, ""),
      ref: remoteHead
    };
  }

  for (const branch of ["main", "master"]) {
    const result = await git(projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (result.exitCode === 0) {
      return {
        name: branch,
        ref: branch
      };
    }
  }

  return currentBranch
    ? {
        name: currentBranch,
        ref: currentBranch
      }
    : undefined;
}

async function gitLines(projectRoot: string, args: string[]) {
  const result = await git(projectRoot, args);
  if (result.exitCode !== 0) {
    return [];
  }

  return result.stdout.split(/\r?\n/u).filter(Boolean);
}

function git(projectRoot: string, args: string[]) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      "git",
      ["-C", projectRoot, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024
      },
      (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
        resolve({
          exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout: stringifyOutput(stdout),
          stderr: stringifyOutput(stderr)
        });
      }
    );
  });
}

function optionalTrimmed(result: { exitCode: number; stdout: string }) {
  if (result.exitCode !== 0) {
    return undefined;
  }

  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
}

function normalizeFiles(files: string[]) {
  return uniqueSorted(files.map(normalizeFile).filter((file) => file && !isIgnoredChangeScopePath(file)));
}

function normalizeFile(filePath: string) {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function isIgnoredChangeScopePath(filePath: string) {
  return (
    filePath === ".agentmatrix" ||
    filePath.startsWith(".agentmatrix/") ||
    filePath === ".git" ||
    filePath.startsWith(".git/") ||
    filePath === "node_modules" ||
    filePath.startsWith("node_modules/")
  );
}

function parseNumstat(lines: string[], source: ChangeScopeDiffEntry["source"]): ChangeScopeDiffEntry[] {
  return lines.flatMap((line) => {
    const [additions, deletions, ...pathParts] = line.split(/\t/u);
    const filePath = normalizeFile(pathParts.join("\t"));
    if (!filePath || isIgnoredChangeScopePath(filePath)) {
      return [];
    }

    return [
      {
        path: filePath,
        additions: parseCount(additions),
        deletions: parseCount(deletions),
        source
      }
    ];
  });
}

async function untrackedEntries(projectRoot: string, files: string[]): Promise<ChangeScopeDiffEntry[]> {
  return (
    await Promise.all(
      files.map(async (filePath) => ({
        path: filePath,
        additions: await countFileLines(path.join(projectRoot, filePath)),
        deletions: 0,
        source: "untracked" as const
      }))
    )
  ).filter((entry) => !isIgnoredChangeScopePath(entry.path));
}

async function countFileLines(filePath: string) {
  try {
    if (!(await stat(filePath)).isFile()) {
      return 0;
    }
    const content = await readFile(filePath, "utf8");
    if (content.length === 0) {
      return 0;
    }
    return content.endsWith("\n") ? content.split(/\r?\n/u).length - 1 : content.split(/\r?\n/u).length;
  } catch {
    return 0;
  }
}

function summarizeDiff(files: string[], entries: ChangeScopeDiffEntry[]): ChangeScopeSummary {
  const additions = entries.reduce((sum, entry) => sum + entry.additions, 0);
  const deletions = entries.reduce((sum, entry) => sum + entry.deletions, 0);
  return {
    files_changed: files.length,
    additions,
    deletions,
    lines_changed: additions + deletions,
    entries
  };
}

function largeChangeHint(summary: ChangeScopeSummary): LargeChangeHint {
  const reasons: string[] = [];
  if (summary.files_changed >= FILE_THRESHOLD) {
    reasons.push(`${summary.files_changed} changed files meets threshold ${FILE_THRESHOLD}.`);
  }
  if (summary.lines_changed >= LINE_THRESHOLD) {
    reasons.push(`${summary.lines_changed} changed lines meets threshold ${LINE_THRESHOLD}.`);
  }

  return {
    is_large: reasons.length > 0,
    file_threshold: FILE_THRESHOLD,
    line_threshold: LINE_THRESHOLD,
    reasons
  };
}

function suggestedCheckShards(files: string[]): CheckShard[] {
  const groups = new Map<string, { name: string; files: string[] }>();

  for (const file of files) {
    const key = shardKey(file);
    const group = groups.get(key.id) ?? { name: key.name, files: [] };
    group.files.push(file);
    groups.set(key.id, group);
  }

  return [...groups.entries()].map(([id, group]) => ({
    id,
    name: group.name,
    files: group.files.sort(),
    rationale: `Inspect ${group.files.length} ${group.name.toLowerCase()} file${group.files.length === 1 ? "" : "s"} together.`
  }));
}

function shardKey(filePath: string) {
  const basename = path.posix.basename(filePath);
  const extension = path.posix.extname(filePath).toLowerCase();

  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension) || basename.startsWith("tsconfig")) {
    return { id: "typescript", name: "TypeScript" };
  }
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension) || ["package.json", "package-lock.json"].includes(basename)) {
    return { id: "javascript", name: "JavaScript" };
  }
  if (extension === ".py" || basename === "pyproject.toml") {
    return { id: "python", name: "Python" };
  }
  if (extension === ".go" || basename === "go.mod") {
    return { id: "go", name: "Go" };
  }
  if (extension === ".rs" || basename === "Cargo.toml") {
    return { id: "rust", name: "Rust" };
  }
  if (extension === ".java" || basename === "pom.xml") {
    return { id: "java", name: "Java" };
  }
  if ([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"].includes(extension)) {
    return { id: "native", name: "Native" };
  }
  if ([".sh", ".bash", ".zsh"].includes(extension) || basename === "Makefile") {
    return { id: "shell", name: "Shell" };
  }
  if ([".md", ".mdx", ".rst"].includes(extension)) {
    return { id: "docs", name: "Docs" };
  }
  if ([".json", ".yaml", ".yml", ".toml"].includes(extension)) {
    return { id: "config", name: "Config" };
  }

  const directory = filePath.includes("/") ? filePath.split("/")[0] : "root";
  return { id: `directory-${slug(directory)}`, name: `${directory}/` };
}

function parseCount(value: string) {
  return /^\d+$/u.test(value) ? Number(value) : 0;
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort();
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "other";
}

function stringifyOutput(output: string | Buffer) {
  return Buffer.isBuffer(output) ? output.toString("utf8") : output;
}
