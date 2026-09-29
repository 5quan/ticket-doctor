// 证据提交失败：按 D9（fail-closed）由工具上抛，让本轮按可重试错误失败。
export class EvidenceCommitError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EvidenceCommitError";
    this.code = code;
  }
}
