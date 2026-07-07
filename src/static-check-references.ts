import path from "node:path";

export interface StaticCheckLanguageReference {
  id: string;
  name: string;
  reference: string;
  matches: string[];
}

interface LanguageDefinition {
  id: string;
  name: string;
  reference: string;
  matches(relativePath: string): boolean;
}

const LANGUAGE_DEFINITIONS: LanguageDefinition[] = [
  {
    id: "c",
    name: "C",
    reference: "static-check/references/c.md",
    matches: (relativePath) =>
      hasExtension(relativePath, [".c", ".h"]) || basenameEquals(relativePath, "compile_commands.json")
  },
  {
    id: "cpp",
    name: "C++",
    reference: "static-check/references/cpp.md",
    matches: (relativePath) =>
      hasExtension(relativePath, [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"]) ||
      basenameEquals(relativePath, "compile_commands.json")
  },
  {
    id: "java",
    name: "Java",
    reference: "static-check/references/java.md",
    matches: (relativePath) =>
      hasExtension(relativePath, [".java"]) ||
      basenameEquals(relativePath, "pom.xml") ||
      basenameEquals(relativePath, "build.gradle") ||
      basenameEquals(relativePath, "build.gradle.kts") ||
      basenameEquals(relativePath, "settings.gradle") ||
      basenameEquals(relativePath, "settings.gradle.kts")
  },
  {
    id: "go",
    name: "Go",
    reference: "static-check/references/go.md",
    matches: (relativePath) =>
      hasExtension(relativePath, [".go"]) ||
      basenameEquals(relativePath, "go.mod") ||
      basenameEquals(relativePath, "go.work")
  },
  {
    id: "rust",
    name: "Rust",
    reference: "static-check/references/rust.md",
    matches: (relativePath) =>
      hasExtension(relativePath, [".rs"]) ||
      basenameEquals(relativePath, "Cargo.toml") ||
      basenameEquals(relativePath, "Cargo.lock")
  },
  {
    id: "javascript",
    name: "JavaScript",
    reference: "static-check/references/javascript.md",
    matches: (relativePath) =>
      hasExtension(relativePath, [".js", ".mjs", ".cjs", ".jsx"]) ||
      basenameEquals(relativePath, "package.json") ||
      basenameEquals(relativePath, "package-lock.json") ||
      basenameEquals(relativePath, "yarn.lock") ||
      basenameEquals(relativePath, "pnpm-lock.yaml")
  },
  {
    id: "typescript",
    name: "TypeScript",
    reference: "static-check/references/typescript.md",
    matches: (relativePath) =>
      hasExtension(relativePath, [".ts", ".tsx", ".mts", ".cts"]) ||
      (basenameStartsWith(relativePath, "tsconfig") && hasExtension(relativePath, [".json"]))
  },
  {
    id: "python",
    name: "Python",
    reference: "static-check/references/python.md",
    matches: (relativePath) =>
      hasExtension(relativePath, [".py"]) ||
      basenameEquals(relativePath, "pyproject.toml") ||
      basenameEquals(relativePath, "setup.cfg") ||
      basenameEquals(relativePath, "poetry.lock") ||
      basenameEquals(relativePath, "uv.lock") ||
      (basenameStartsWith(relativePath, "requirements") && hasExtension(relativePath, [".txt"]))
  },
  {
    id: "shell",
    name: "Shell",
    reference: "static-check/references/shell.md",
    matches: (relativePath) =>
      hasExtension(relativePath, [".sh", ".bash", ".zsh", ".ksh"]) ||
      basenameEquals(relativePath, "Makefile")
  }
];

export function selectStaticCheckLanguageReferences(projectFiles: string[]): StaticCheckLanguageReference[] {
  return LANGUAGE_DEFINITIONS.flatMap((definition) => {
    const matches = projectFiles.filter((relativePath) => definition.matches(relativePath));
    if (matches.length === 0) {
      return [];
    }

    return [
      {
        id: definition.id,
        name: definition.name,
        reference: definition.reference,
        matches: matches.slice(0, 25)
      }
    ];
  });
}

function hasExtension(relativePath: string, extensions: string[]) {
  const extension = path.posix.extname(relativePath).toLowerCase();
  return extensions.includes(extension);
}

function basenameEquals(relativePath: string, basename: string) {
  return path.posix.basename(relativePath) === basename;
}

function basenameStartsWith(relativePath: string, prefix: string) {
  return path.posix.basename(relativePath).startsWith(prefix);
}
