#!/usr/bin/env node
// 把 `opencode session export <id>` 产出的 JSON 转成 Capsule 可识别的 Claude Code JSONL。
// 本脚本为本实验自写，不包含 clean-session-curate 的代码（该仓库无 LICENSE 文件）。
//
// 用法：
//   node convert.mjs --in <导出目录> --out <转换目录>
//
// 输入：<导出目录> 内若干 `*.json`，结构为 { info, messages }（opencode session export 的原样输出）。
// 输出：<转换目录> 内 `opencode_001.jsonl` … 匿名连续编号，按会话创建时间排序。
//
// 转换约定（对应 clean-session-curate SKILL.md 的 Unsupported Formats 一节）：
//   - 保留事件顺序、角色、时间戳、工具调用与结果、正文、权威项目位置（cwd）
//   - 不可映射的元数据（会话 id、消息 id、cost、snapshot、finish）一律不写
//   - 工具调用 id 重排为匿名连续号 `tool_NNN`

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
}

const inputDir = resolve(optionValue("--in") ?? (() => { throw new Error("Missing required option --in <dir>."); })());
const outputDir = resolve(optionValue("--out") ?? (() => { throw new Error("Missing required option --out <dir>."); })());

function iso(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function toolResultText(state) {
  const parts = Array.isArray(state?.content) ? state.content : [];
  const text = parts.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
  if (text) return text;
  if (state?.error && typeof state.error.message === "string") return state.error.message;
  return "";
}

function convert(file, sessionId) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const info = data.info ?? {};
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const cwd = info?.location?.directory;
  const lines = [];
  let toolSeq = 0;
  const toolIds = new Map();

  const toolId = (rawId) => {
    if (!toolIds.has(rawId)) toolIds.set(rawId, `tool_${String(++toolSeq).padStart(3, "0")}`);
    return toolIds.get(rawId);
  };

  // Capsule 的格式探测要求前 10 行内出现 sessionId，否则判为 unknown；
  // 这里用匿名连续号，不带任何源会话标识。
  const base = (timestamp, type) => ({ type, sessionId, timestamp, ...(cwd ? { cwd } : {}) });

  for (const message of messages) {
    const timestamp = iso(message?.time?.created);

    if (message.type === "user") {
      lines.push({ ...base(timestamp, "user"), message: { role: "user", content: message.text ?? "" } });
      continue;
    }

    if (message.type === "system") {
      // Capsule 的 Claude 解析器只认 turn_duration 的 system 行，其余跳过；
      // 这里照实写入，交给 Capsule 的 removeSystemMessages 删除，便于验证该开关生效。
      lines.push({ ...base(timestamp, "system"), subtype: "opencode", message: { role: "system", content: message.text ?? "" } });
      continue;
    }

    if (message.type !== "assistant") continue;

    const content = Array.isArray(message.content) ? message.content : [];
    const blocks = [];
    const results = [];

    for (const part of content) {
      if (part.type === "reasoning" && typeof part.text === "string") {
        blocks.push({ type: "thinking", thinking: part.text });
      } else if (part.type === "text" && typeof part.text === "string") {
        blocks.push({ type: "text", text: part.text });
      } else if (part.type === "tool") {
        const id = toolId(part.id);
        blocks.push({ type: "tool_use", id, name: part.name ?? "tool", input: part.state?.input ?? {} });
        results.push({
          type: "tool_result",
          tool_use_id: id,
          content: toolResultText(part.state),
          is_error: part.state?.status === "error",
        });
      }
    }

    if (blocks.length === 0) continue;

    const tokens = message.tokens ?? {};
    const cache = tokens.cache ?? {};
    const usage = {
      input_tokens: tokens.input ?? 0,
      output_tokens: tokens.output ?? 0,
      cache_read_input_tokens: cache.read ?? 0,
      cache_creation_input_tokens: cache.write ?? 0,
    };

    lines.push({
      ...base(timestamp, "assistant"),
      message: {
        role: "assistant",
        ...(message.model?.id ? { model: message.model.id } : {}),
        content: blocks,
        usage,
      },
    });

    if (results.length > 0) {
      lines.push({
        ...base(timestamp, "user"),
        message: { role: "user", content: results },
      });
    }
  }

  return lines;
}

const files = readdirSync(inputDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => join(inputDir, name))
  .sort((left, right) => {
    const created = (f) => {
      try {
        return JSON.parse(readFileSync(f, "utf8"))?.info?.time?.created ?? 0;
      } catch {
        return 0;
      }
    };
    return created(left) - created(right) || left.localeCompare(right);
  });

mkdirSync(outputDir, { recursive: true });
let seq = 0;
let written = 0;
for (const file of files) {
  if (statSync(file).size === 0) continue;
  seq += 1;
  const sessionId = `session_${String(seq).padStart(3, "0")}`;
  const lines = convert(file, sessionId);
  if (lines.length === 0) continue;
  written += 1;
  const target = join(outputDir, `opencode_${String(seq).padStart(3, "0")}.jsonl`);
  writeFileSync(target, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  process.stdout.write(`${target} (${lines.length} lines)\n`);
}
process.stdout.write(`converted ${written} session(s)\n`);
