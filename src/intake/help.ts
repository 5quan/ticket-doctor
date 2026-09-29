// 机械回复文案（Host 出文案，适配器发送——feishu-trigger-design §2.3）。
// 目前只有 `-help` 命令使用；gateway（Host 直连旧路径）与经适配器的新路径共用，避免两份文案。
export const HELP_TEXT = [
  "【ticket-doctor 使用说明】",
  "• 提交 Bug：在群里 @我，尽量带上「服务名、发生时间、现象/报错」。",
  "• 继续追问：回复我的报告，保留末尾的 [TD-xxxxxxxx] 标号即可续接。",
  "• 我只做只读预检（查日志 + 读源码），不会修改任何东西。",
].join("\n");
