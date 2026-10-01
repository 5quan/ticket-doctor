// 隔离预检（方案 §10.2）：答案不进 Agent 能力范围，未来材料不进当前轮工具范围。
//
// 两类检查：
//   1. 路径闭包：私有目录不得落在任何工具可达目录内；各轮材料视图不得互相嵌套。
//   2. 内容泄漏：当前轮可读材料（日志文本 + 仓库 pinned tree 文本）不得包含
//      未来轮用户消息正文；材料/仓库内不得出现答案性文件名。
//
// 这是评测开工前的准入门槛，不是运行时沙箱：任何 violation 都阻止该 case 进入正式评测。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CaseDescriptorV2, TruthFileV2 } from "./types.ts";

export interface IsolationViolation {
  code: "path_overlap" | "future_message_leak" | "answer_filename" | "repo_not_pinned";
  message: string;
}

const ANSWER_FILENAME_RE = /(truth|gold|answer|solution|private|\.patch$|\.diff$)/i;

function normText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 当前轮可读的仓库文件（pinned tree；超过大小/数量上限的跳过并计数）。 */
export function repoTextFiles(
  repoDir: string,
  ref: string,
  limits?: { maxFiles?: number; maxFileBytes?: number },
): { files: Array<{ path: string; text: string }>; skipped: number } {
  const maxFiles = limits?.maxFiles ?? 500;
  const maxFileBytes = limits?.maxFileBytes ?? 512 * 1024;
  const stdout = execFileSync("git", ["-C", repoDir, "ls-tree", "-r", "--name-only", ref], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const paths = stdout.split(/\r?\n/).filter(Boolean);
  const files: Array<{ path: string; text: string }> = [];
  let skipped = 0;
  for (const path of paths.slice(0, maxFiles)) {
    try {
      const raw = execFileSync("git", ["-C", repoDir, "show", `${ref}:${path}`], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      });
      if (raw.length > maxFileBytes) {
        skipped += 1;
        continue;
      }
      files.push({ path, text: raw });
    } catch {
      skipped += 1;
    }
  }
  if (paths.length > maxFiles) skipped += paths.length - maxFiles;
  return { files, skipped };
}

function isAnswerFilename(name: string): boolean {
  return ANSWER_FILENAME_RE.test(name);
}

function listDirFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = `${prefix}${prefix ? "/" : ""}${entry.name}`;
    if (entry.isDirectory()) out.push(...listDirFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/** 对一个 case 做全轮隔离预检；返回空数组 = 通过。 */
export function checkIsolation(
  projectRoot: string,
  caseDir: string,
  caseDesc: CaseDescriptorV2,
  _truth: TruthFileV2,
  privateDir: string,
): IsolationViolation[] {
  const violations: IsolationViolation[] = [];
  const resolveUnder = (p: string) => resolve(projectRoot, p);

  // 1. 路径闭包：私有目录与各轮材料视图不得互相包含。
  const reachable = new Set<string>();
  for (const round of caseDesc.rounds) {
    reachable.add(resolveUnder(join(caseDir, round.materialView)));
    for (const repo of round.repos) reachable.add(resolveUnder(repo.dir));
  }
  const privAbs = resolveUnder(privateDir);
  for (const dir of reachable) {
    if (privAbs === dir || privAbs.startsWith(dir + "/") || privAbs.startsWith(dir + sep2())) {
      violations.push({ code: "path_overlap", message: `私有目录 ${privateDir} 落在工具可达目录内` });
    }
  }
  for (let i = 0; i < caseDesc.rounds.length; i++) {
    for (let j = i + 1; j < caseDesc.rounds.length; j++) {
      const earlier = resolveUnder(join(caseDir, caseDesc.rounds[i].materialView));
      const later = resolveUnder(join(caseDir, caseDesc.rounds[j].materialView));
      if (earlier === later) {
        violations.push({
          code: "path_overlap",
          message: `round ${caseDesc.rounds[j].roundId} 与先前轮共用材料视图，未来材料提前可读`,
        });
      }
    }
  }

  // 2. 答案性文件名不得出现在材料视图与仓库 tree。
  for (const round of caseDesc.rounds) {
    const viewDir = join(caseDir, round.materialView);
    for (const f of listDirFiles(viewDir)) {
      if (isAnswerFilename(f.split("/").pop() ?? f)) {
        violations.push({ code: "answer_filename", message: `材料视图 ${round.materialView} 内出现答案性文件名：${f}` });
      }
    }
    for (const repo of round.repos) {
      const repoDir = resolve(projectRoot, repo.dir);
      if (!existsSync(join(repoDir, ".git"))) {
        violations.push({ code: "repo_not_pinned", message: `仓库 ${repo.dir} 不是 git 仓库，无法钉版本` });
        continue;
      }
      const ref = repo.expectedSha ?? "HEAD";
      try {
        const tree = execFileSync("git", ["-C", repoDir, "ls-tree", "-r", "--name-only", ref], {
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        });
        for (const f of tree.split(/\r?\n/).filter(Boolean)) {
          if (isAnswerFilename(f.split("/").pop() ?? f)) {
            violations.push({
              code: "answer_filename",
              message: `仓库 ${repo.dir}@${ref.slice(0, 10)} 内出现答案性文件名：${f}`,
            });
          }
        }
      } catch (err) {
        violations.push({
          code: "repo_not_pinned",
          message: `仓库 ${repo.dir} 无法解析 ${ref.slice(0, 10)}：${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        });
      }
    }
  }

  // 3. 未来轮用户消息不得泄漏进先前轮可读材料。
  for (let i = 0; i < caseDesc.rounds.length; i++) {
    const futureTexts: string[] = [];
    for (let j = i + 1; j < caseDesc.rounds.length; j++) {
      try {
        futureTexts.push(normText(readFileSync(join(caseDir, caseDesc.rounds[j].messageRef), "utf8")));
      } catch {
        // schema 已查存在性；此处容错
      }
    }
    if (futureTexts.length === 0) continue;
    const round = caseDesc.rounds[i];
    const viewDir = join(caseDir, round.materialView);
    const haystacks: Array<{ where: string; text: string }> = [];
    for (const f of listDirFiles(viewDir)) {
      const p = join(viewDir, f);
      if (statSync(p).isFile() && statSync(p).size <= 1024 * 1024) {
        haystacks.push({ where: `${round.materialView}/${f}`, text: readFileSync(p, "utf8") });
      }
    }
    for (const repo of round.repos) {
      if (!repo.expectedSha) continue; // 候选期无 SHA：泄漏检查降级为仅材料视图
      const { files } = repoTextFiles(resolve(projectRoot, repo.dir), repo.expectedSha);
      for (const f of files) {
        haystacks.push({ where: `${repo.repoId}@${repo.expectedSha.slice(0, 10)}:${f.path}`, text: f.text });
      }
    }
    for (const hay of haystacks) {
      const hayNorm = normText(hay.text);
      for (const future of futureTexts) {
        if (future.length >= 12 && hayNorm.includes(future)) {
          violations.push({ code: "future_message_leak", message: `${hay.where} 包含未来轮用户消息正文` });
        }
      }
    }
  }

  return violations;
}

function sep2(): string {
  return process.platform === "win32" ? "\\" : "/";
}

/** 供 manifest 记录的隔离结论摘要。 */
export function isolationSummary(violations: IsolationViolation[]): { ok: boolean; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const v of violations) counts[v.code] = (counts[v.code] ?? 0) + 1;
  return { ok: violations.length === 0, counts };
}
