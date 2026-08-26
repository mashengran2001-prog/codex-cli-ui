/**
 * 终端输出流热路径分析（性能模块：轻快、响应快的持续优化）。
 * 预编译正则 + 无 ESC 快检：普通文本块不做任何转义扫描，减少主进程每块输出的正则分配。
 */

export interface TerminalChunkAnalysis {
  /** 块里是否含 ESC——不含则常规输出几乎可跳过全部转义处理。 */
  hasEscape: boolean;
  /** OSC 7 当前目录的编码路径（尚未 decode）。 */
  osc7: readonly string[];
  /** 是否出现 133;D / 133;A 命令收尾标记。 */
  commandFinished: boolean;
  /** 剥离 OSC/CSI 后是否命中"等待输入"语义（无 ESC 块直接全文快检）。 */
  attention: boolean;
  /** 命中 attention 时的纯文本消息（trim + 180 字符），供通知展示。 */
  attentionMessage?: string;
}

const OSC7_RE = /\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)[\x07\x1b\\]/g;
const CMD_FINISH_RE = /\x1b\]133;(?:D(?:;[^\x07]*)?|A)\x07/;
const STRIP_OSC_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const STRIP_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ATTENTION_RE = /(?:do you want to continue|needs? your (?:input|approval)|press enter|\[[yY]\/[nN]\]|allow this command)/i;

export function analyzeTerminalChunk(data: string): TerminalChunkAnalysis {
  const hasEscape = data.includes("\x1b");
  if (!hasEscape) {
    const attention = ATTENTION_RE.test(data);
    return {
      hasEscape: false,
      osc7: [],
      commandFinished: false,
      attention,
      attentionMessage: attention ? data.trim().slice(-180) || undefined : undefined,
    };
  }
  const osc7: string[] = [];
  for (const match of data.matchAll(OSC7_RE)) osc7.push(match[1]);
  const plain = data.replace(STRIP_OSC_RE, "").replace(STRIP_CSI_RE, "");
  const attention = ATTENTION_RE.test(plain);
  return {
    hasEscape: true,
    osc7,
    commandFinished: CMD_FINISH_RE.test(data),
    attention,
    attentionMessage: attention ? plain.trim().slice(-180) || undefined : undefined,
  };
}
