#!/usr/bin/env node
// 把 pi 会话 JSONL（~/.pi/agent/sessions/<slug>/<ts>_<uuid>.jsonl）转成 Capsule 可识别的 Claude Code JSONL。
// 本脚本为本实验自写，不包含 clean-session-curate 的代码（该仓库无 LICENSE 文件）。
//
// 用法：
//   node convert.mjs --list <清单文件> --out <转换目录>
// 清单每行：`<会话文件绝对路径>\t<该会话首行的 cwd>`
//
// 转换约定（对应 clean-session-curate SKILL.md 的 Unsupported Formats 一节）：
//   - 保留事件顺序、角色、时间戳、工具调用与结果、正文、权威项目位置（cwd）
//   - 不可映射的元数据（会话 id、消息 id、responseId、stopReason、cost、compaction、model_change 等）一律不写
//   - 会话 id 用匿名连续号 `session_NNN`，工具调用 id 重排为 `tool_NNN`

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
}

const listPath = resolve(optionValue("--list") ?? (() => { throw new Error("Missing required option --list <file>."); })());
const outputDir = resolve(optionValue("--out") ?? (() => { throw new Error("Missing required option --out <dir>."); })());

function iso(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function blockText(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function convert(file, cwd, sessionId) {
  const lines = [];
  const toolIds = new Map();
  let toolSeq = 0;
  const toolId = (rawId) => {
    if (!toolIds.has(rawId)) toolIds.set(rawId, `tool_${String(++toolSeq).padStart(3, "0")}`);
    return toolIds.get(rawId);
  };
  const base = (timestamp, type) => ({ type, sessionId, timestamp, ...(cwd ? { cwd } : {}) });

  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 坏行跳过，不中断整个会话
    }
    if (entry.type !== "message") continue;
    const message = entry.message ?? {};
    const timestamp = iso(entry.timestamp ?? message.timestamp);

    if (message.role === "user") {
      lines.push({ ...base(timestamp, "user"), message: { role: "user", content: blockText(message.content) } });
      continue;
    }

    if (message.role === "toolResult") {
      lines.push({
        ...base(timestamp, "user"),
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: toolId(message.toolCallId),
            content: blockText(message.content),
            is_error: message.isError === true,
          }],
        },
      });
      continue;
    }

    if (message.role !== "assistant") continue;

    const blocks = [];
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "thinking" && typeof part.thinking === "string") {
        blocks.push({ type: "thinking", thinking: part.thinking });
      } else if (part.type === "text" && typeof part.text === "string") {
        blocks.push({ type: "text", text: part.text });
      } else if (part.type === "toolCall") {
        blocks.push({ type: "tool_use", id: toolId(part.id), name: part.name ?? "tool", input: part.arguments ?? {} });
      }
    }
    if (blocks.length === 0) continue;

    const usage = message.usage ?? {};
    lines.push({
      ...base(timestamp, "assistant"),
      message: {
        role: "assistant",
        ...(typeof message.model === "string" ? { model: message.model } : {}),
        content: blocks,
        usage: {
          input_tokens: usage.input ?? 0,
          output_tokens: usage.output ?? 0,
          cache_read_input_tokens: usage.cacheRead ?? 0,
          cache_creation_input_tokens: usage.cacheWrite ?? 0,
        },
      },
    });
  }

  return lines;
}

const entries = readFileSync(listPath, "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => {
    const [file, cwd] = l.split("\t");
    return { file, cwd };
  });

mkdirSync(outputDir, { recursive: true });
let seq = 0;
let written = 0;
for (const { file, cwd } of entries) {
  seq += 1;
  const sessionId = `session_${String(seq).padStart(3, "0")}`;
  const lines = convert(file, cwd, sessionId);
  if (lines.length === 0) {
    process.stderr.write(`skip (no lines): ${file}\n`);
    continue;
  }
  written += 1;
  const target = join(outputDir, `pi_${String(seq).padStart(3, "0")}.jsonl`);
  writeFileSync(target, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  process.stdout.write(`${target} (${lines.length} lines)\n`);
}
process.stdout.write(`converted ${written} session(s)\n`);
