// 隔离预检（方案 §10.1/§10.2）：答案不进 Agent 能力范围，未来材料不进当前轮工具范围。
//
// 检查彼此独立（某项跳过不得影响其他项结论，完整性缺口单独成 violation）：
//   1. 路径闭包：私有目录不落在任何工具可达目录内；各轮视图按真实路径两两判重并
//      拒绝任意方向的父子包含（目录符号链接/junction 别名在真实路径下必然重合或嵌套）。
//   2. 答案性文件名：材料视图与仓库 pinned tree 内不得出现答案性命名。
//   3. 链接逃逸：视图内链接（含 junction）指向视图外 → link_escape。
//   4. 跨轮硬链接：先前轮已授权文件的 inode 与未来轮文件相同 → hardlink_escape
//      （硬链接在运行期无法用 realpath/路径规则发现，只能在预检按 inode 识别）。
//   5. 扫描完整性：与"是否存在未来消息"分离——每轮（单轮/末轮也算）对视图文件与
//      仓库树（expectedSha 与 HEAD 两棵）扫描，超限或失败 → incomplete_scan，不判隔离通过。
//   6. 未来消息泄漏：仅对存在未来轮的轮次，用第 5 步收集的文本查泄漏。
//
// 这是评测开工前的准入门槛，不是运行时沙箱：任何 violation 都阻止该 case 进入正式评测。
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { CaseDescriptorV2, TruthFileV2 } from "./types.ts";

export interface IsolationViolation {
  code:
    | "path_overlap"
    | "future_message_leak"
    | "answer_filename"
    | "repo_not_pinned"
    | "link_escape"
    | "hardlink_escape"
    | "incomplete_scan";
  message: string;
}

export interface IsolationLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  maxViewFileBytes?: number;
}

export interface ViewFileRecord {
  rel: string;
  abs: string;
  real: string;
  size: number;
  dev: number;
  ino: number;
  isLink: boolean;
  text?: string;
}

export interface ViewScanResult {
  roundId: string;
  viewDir: string;
  realViewDir: string;
  files: ViewFileRecord[];
  skipped: number;
}

const ANSWER_FILENAME_RE = /(truth|gold|answer|solution|private|\.patch$|\.diff$)/i;

function normText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function realOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
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
    // 目录符号链接不递归（按文件记录其身份，交由链接逃逸/inode 检查判定）
    if (entry.isDirectory() && !entry.isSymbolicLink()) out.push(...listDirFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/** 仓库 pinned tree 的文本文件（超过大小/数量上限的跳过并计数）。 */
export function repoTextFiles(
  repoDir: string,
  ref: string,
  limits?: { maxFiles?: number; maxFileBytes?: number },
): { files: Array<{ path: string; text: string }>; skipped: number; failed: boolean } {
  const maxFiles = limits?.maxFiles ?? 500;
  const maxFileBytes = limits?.maxFileBytes ?? 512 * 1024;
  const stdout = execFileSync("git", ["-C", repoDir, "ls-tree", "-r", "--name-only", ref], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const paths = stdout.split(/\r?\n/).filter(Boolean);
  const files: Array<{ path: string; text: string }> = [];
  let skipped = 0;
  let failed = false;
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
      failed = true;
    }
  }
  if (paths.length > maxFiles) skipped += paths.length - maxFiles;
  return { files, skipped, failed };
}

/** 对一个 case 做全轮隔离预检；返回空数组 = 通过。limits 供测试收紧扫描阈值。 */
export function checkIsolation(
  projectRoot: string,
  caseDir: string,
  caseDesc: CaseDescriptorV2,
  _truth: TruthFileV2,
  privateDir: string,
  limits: IsolationLimits = {},
): IsolationViolation[] {
  const violations: IsolationViolation[] = [];
  const resolveUnder = (p: string) => resolve(projectRoot, p);
  const maxViewFileBytes = limits.maxViewFileBytes ?? 1024 * 1024;
  const maxRepoFileBytes = limits.maxFileBytes ?? 512 * 1024;
  const maxRepoFiles = limits.maxFiles ?? 500;
  let integritySkipped = 0;
  const integrityNotes: string[] = [];

  // —— 每轮视图扫描（单轮/末轮同样执行；结果供闭包/链接/硬链接/完整性/泄漏共用） ——
  const scans: ViewScanResult[] = [];
  for (const round of caseDesc.rounds) {
    const viewDir = resolveUnder(join(caseDir, round.materialView));
    const realViewDir = realOf(viewDir);
    const files: ViewFileRecord[] = [];
    let skipped = 0;
    for (const rel of listDirFiles(viewDir)) {
      const abs = join(viewDir, rel);
      let lst;
      try {
        lst = lstatSync(abs);
      } catch {
        integritySkipped += 1;
        integrityNotes.push(`${round.materialView}/${rel}: lstat 失败`);
        continue;
      }
      const real = realOf(abs);
      if (lst.isSymbolicLink() && real !== realViewDir && !real.startsWith(realViewDir + sep)) {
        violations.push({
          code: "link_escape",
          message: `材料视图 ${round.materialView} 内的链接 ${rel} 指向视图之外（${real}）——链接逃逸`,
        });
      }
      let st;
      try {
        st = statSync(abs);
      } catch {
        integritySkipped += 1;
        integrityNotes.push(`${round.materialView}/${rel}: stat 失败`);
        continue;
      }
      if (st.isFile() && st.size > maxViewFileBytes) {
        skipped += 1;
        integritySkipped += 1;
        integrityNotes.push(`${round.materialView}/${rel}: 文件 ${st.size}B 超过视图扫描阈值`);
      }
      const record: ViewFileRecord = {
        rel,
        abs,
        real,
        size: st.size,
        dev: Number(st.dev),
        ino: Number(st.ino),
        isLink: lst.isSymbolicLink(),
      };
      if (st.isFile() && st.size <= maxViewFileBytes) {
        record.text = readFileSync(abs, "utf8");
      }
      files.push(record);
      if (isAnswerFilename(rel.split("/").pop() ?? rel)) {
        violations.push({ code: "answer_filename", message: `材料视图 ${round.materialView} 内出现答案性文件名：${rel}` });
      }
    }
    scans.push({ roundId: round.roundId, viewDir, realViewDir, files, skipped });
  }

  // —— 1. 路径闭包：私有目录；视图两两关系（相等或任一方向父子包含，真实路径） ——
  const privAbs = realOf(resolveUnder(privateDir));
  const allReachableReal = new Set<string>([
    ...scans.map((s) => s.realViewDir),
    ...caseDesc.rounds.flatMap((r) => r.repos.map((repo) => realOf(resolveUnder(repo.dir)))),
  ]);
  for (const dir of allReachableReal) {
    if (privAbs === dir || privAbs.startsWith(dir + sep)) {
      violations.push({ code: "path_overlap", message: `私有目录 ${privateDir} 落在工具可达目录 ${dir} 内` });
    }
  }
  for (let i = 0; i < scans.length; i++) {
    for (let j = i + 1; j < scans.length; j++) {
      const a = scans[i]!;
      const b = scans[j]!;
      if (a.realViewDir === b.realViewDir) {
        violations.push({
          code: "path_overlap",
          message: `round ${b.roundId} 与先前轮 ${a.roundId} 材料视图真实路径重合（含目录别名），未来材料提前可读`,
        });
      } else if (b.realViewDir.startsWith(a.realViewDir + sep)) {
        violations.push({
          code: "path_overlap",
          message: `round ${b.roundId} 材料视图（${b.realViewDir}）位于先前轮 ${a.roundId} 视图（${a.realViewDir}）内部——先轮可读未来材料`,
        });
      } else if (a.realViewDir.startsWith(b.realViewDir + sep)) {
        violations.push({
          code: "path_overlap",
          message: `round ${a.roundId} 材料视图（${a.realViewDir}）位于 round ${b.roundId} 视图（${b.realViewDir}）内部——视图边界不成立`,
        });
      }
    }
  }

  // —— 2. 仓库：答案性文件名 + 扫描完整性（expectedSha 与 HEAD 两棵树；独立于未来消息检查） ——
  const repoHaystacks: Array<{ where: string; text: string; roundIndex: number }> = [];
  caseDesc.rounds.forEach((round, roundIndex) => {
    for (const repo of round.repos) {
      const repoDir = resolve(projectRoot, repo.dir);
      if (!existsSync(join(repoDir, ".git"))) {
        violations.push({ code: "repo_not_pinned", message: `仓库 ${repo.dir} 不是 git 仓库，无法钉版本` });
        integritySkipped += 1;
        integrityNotes.push(`${repo.repoId}: 非 git 仓库，树扫描未执行`);
        continue;
      }
      const refs = [...new Set([...(repo.expectedSha ? [repo.expectedSha] : []), "HEAD"])];
      for (const ref of refs) {
        try {
          const { files, skipped, failed } = repoTextFiles(repoDir, ref, { maxFiles: maxRepoFiles, maxFileBytes: maxRepoFileBytes });
          if (skipped > 0 || failed) {
            integritySkipped += skipped + (failed ? 1 : 0);
            integrityNotes.push(`${repo.repoId}@${ref.slice(0, 10)}: ${skipped} 个文件跳过${failed ? "（部分读取失败）" : ""}`);
          }
          for (const f of files) {
            if (isAnswerFilename(f.path.split("/").pop() ?? f.path)) {
              violations.push({
                code: "answer_filename",
                message: `仓库 ${repo.dir}@${ref.slice(0, 10)} 内出现答案性文件名：${f.path}`,
              });
            }
            repoHaystacks.push({ where: `${repo.repoId}@${ref.slice(0, 10)}:${f.path}`, text: f.text, roundIndex });
          }
        } catch (err) {
          violations.push({
            code: "repo_not_pinned",
            message: `仓库 ${repo.dir} 无法解析 ${ref.slice(0, 10)}：${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
          });
          integritySkipped += 1;
          integrityNotes.push(`${repo.repoId}@${ref.slice(0, 10)}: 树不可读`);
        }
      }
    }
  });

  // —— 3. 跨轮硬链接：先前轮视图文件的 (dev,ino) 与未来轮视图文件重合 → 运行期已授权即可读 ——
  for (let i = 0; i < scans.length; i++) {
    for (let j = i + 1; j < scans.length; j++) {
      for (const ef of scans[i]!.files) {
        for (const lf of scans[j]!.files) {
          if (ef.dev === lf.dev && ef.ino === lf.ino) {
            violations.push({
              code: "hardlink_escape",
              message: `round ${scans[j]!.roundId} 的 ${lf.rel} 与先前轮 ${scans[i]!.roundId} 已授权文件 ${ef.rel} 为同一 inode（硬链接）——首轮即可读未来内容`,
            });
          }
        }
      }
    }
  }

  // —— 4. 未来消息泄漏（独立于完整性；仅存在未来轮的轮次参与） ——
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
    const haystacks: Array<{ where: string; text: string }> = scans[i]!.files
      .filter((f) => f.text !== undefined)
      .map((f) => ({ where: `${caseDesc.rounds[i].materialView}/${f.rel}`, text: f.text! }));
    for (const hay of repoHaystacks.filter((h) => h.roundIndex === i)) {
      haystacks.push({ where: hay.where, text: hay.text });
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

  // —— 5. 完整性结论：任何跳过/失败都使隔离结论不完整，不得判通过 ——
  if (integritySkipped > 0) {
    violations.push({
      code: "incomplete_scan",
      message: `扫描跳过/失败 ${integritySkipped} 项（${integrityNotes.slice(0, 5).join("; ")}${integrityNotes.length > 5 ? "…" : ""}）——可读内容未全部核验，隔离结论不完整`,
    });
  }
  return violations;
}

/** 材料目录真实位置（manifest 记录 + 授权归属核验用）。 */
export function materialRealPaths(
  projectRoot: string,
  caseDir: string,
  caseDesc: CaseDescriptorV2,
): Array<{ roundId: string; viewDir: string; realViewDir: string; authorizedServices: string[] }> {
  return caseDesc.rounds.map((round) => {
    const viewDir = resolve(projectRoot, join(caseDir, round.materialView));
    return { roundId: round.roundId, viewDir, realViewDir: realOf(viewDir), authorizedServices: [...round.services] };
  });
}

/** 供 manifest 记录的隔离结论摘要。 */
export function isolationSummary(violations: IsolationViolation[]): { ok: boolean; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const v of violations) counts[v.code] = (counts[v.code] ?? 0) + 1;
  return { ok: violations.length === 0, counts };
}
