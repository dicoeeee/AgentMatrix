import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeProjectJson(projectRoot: string, relativePath: string, data: unknown) {
  await writeProjectText(projectRoot, relativePath, JSON.stringify(data, null, 2) + "\n");
}

export async function writeProjectText(projectRoot: string, relativePath: string, data: string) {
  const filePath = path.join(projectRoot, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, data);
}
