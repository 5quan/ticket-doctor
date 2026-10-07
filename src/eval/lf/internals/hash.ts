// hash：manifest 与口径锚点用的确定性指纹（方案 §11.2：完整 SHA-256，规范化规则固定）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { MaterialFileEntry, MaterialManifestV2 } from "./types.ts";

export function sha256Bytes(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

/** 目录内全部文件的相对路径统一为 / 分隔后排序，逐个计入 path\0sha256\0size。 */
export function listFilesRecursive(dir: string, prefix = ""): MaterialFileEntry[] {
  const out: MaterialFileEntry[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, entry.name);
    const rel = `${prefix}${prefix ? "/" : ""}${entry.name}`;
    if (entry.isDirectory()) out.push(...listFilesRecursive(p, rel));
    else if (entry.isFile()) {
      const data = readFileSync(p);
      out.push({ path: rel, sha256: sha256Bytes(data), bytes: data.length });
    }
  }
  return out;
}

/** 材料视图 manifest：文件清单 + 目录整体 hash（方案 §11.2 的规范化哈希）。 */
export function buildMaterialManifest(viewDir: string, materialView: string): MaterialManifestV2 {
  const files = listFilesRecursive(viewDir);
  const canonical = files
    .map((f) => `${f.path}\0${f.sha256}\0${f.bytes}`)
    .join("\n");
  return {
    materialView,
    files,
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    viewHash: sha256Bytes(canonical),
  };
}

/** git 仓库在指定提交下的受控文件清单（隔离预检用；只读 tree，不含 .git）。 */
export function gitTreeFileList(repoDir: string, ref: string): string[] {
  const stdout = execFileSync("git", ["-C", repoDir, "ls-tree", "-r", "--name-only", ref], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.split(/\r?\n/).filter(Boolean).sort();
}

/**
 * 供 manifest 汇总的仓库目录指纹：HEAD SHA + tree 清单 hash。
 * git 不可读（dubious ownership、非 git 目录等）时回退为**目录内容指纹**（排除 .git），
 * basis 显式标记——绝不因 git 失败而记 null 让漂移检测失效（交付 1.1 #4）。
 */
export function repoFingerprint(repoDir: string): { head?: string | null; treeHash?: string | null; dirty?: boolean | null; basis?: "git-tree" | "content-fallback" } {
  try {
    const head = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const treeHash = sha256Bytes(gitTreeFileList(repoDir, head).join("\n"));
    const dirty = execFileSync("git", ["-C", repoDir, "status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
    return { head, treeHash, dirty, basis: "git-tree" };
  } catch {
    try {
      const files = listFilesRecursive(repoDir).filter((f) => !f.path.split("/").includes(".git"));
      const treeHash = sha256Bytes(files.map((f) => `${f.path}\0${f.sha256}\0${f.bytes}`).join("\n"));
      return { head: null, treeHash, dirty: null, basis: "content-fallback" };
    } catch {
      return {};
    }
  }
}

/** 绝对路径 → 相对项目根的 posix 路径（manifest 展示用，规避平台分隔符差异）。 */
export function toPosixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}
