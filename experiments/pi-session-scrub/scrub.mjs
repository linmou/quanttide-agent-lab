#!/usr/bin/env node
// 第二道清扫：Capsule 之后的敏感串扫描与替换。
//
// 用法：
//   node scrub.mjs --dir <清洗后的导出目录>          # 扫描并替换，写回
//   node scrub.mjs --dir <清洗后的导出目录> --check  # 只扫描不写，有命中即非零退出
//
// 为什么需要它：Capsule 的七项开关只认路径样式的字符串，对以下四类无效（均在本实验实测到）：
//   1. 正文与工具入参里的密钥（sk-…、云 AK、Bearer）
//   2. 人名与邮箱（git 提交命令里的 user.name / user.email）
//   3. 部署域名与桶名（*.quanttide.com、*.oss-cn-*.aliyuncs.com）
//   4. 落在数组元素里的绝对路径（Capsule 的 maskPathsInObject 不递归数组）
//
// 命中一律精确替换成占位符，并逐行校验 JSON 仍合法；只记数量，不记命中内容。
// 注意：模式一律不加 \b 词边界——会话正文在 JSON 里是转义串，`\n` 的 n 是词字符，
// 行首的词会被 \b 挡在门外（本实验实测漏过一处桶名）。

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
}

const dir = resolve(optionValue("--dir") ?? (() => { throw new Error("Missing required option --dir <dir>."); })());
const checkOnly = process.argv.includes("--check");

// 顺序敏感：密钥 → 邮箱 → 人名 → 域名/桶名 → 家目录路径
const RULES = [
  ["secrets", [
    [/sk-[A-Za-z0-9_\-]{8,}/g, "[REDACTED]"],
    [/ghp_[A-Za-z0-9]{16,}/g, "[REDACTED]"],
    [/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
    [/AKIA[0-9A-Z]{12,}/g, "[REDACTED]"],
    [/LTAI[A-Za-z0-9]{12,}/g, "[REDACTED]"],
    [/AKID[A-Za-z0-9]{12,}/g, "[REDACTED]"],
    [/xox[baprs]-[A-Za-z0-9\-]{10,}/g, "[REDACTED]"],
    [/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9\-]+/g, "[REDACTED]"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]"],
    [/Bearer\s+[A-Za-z0-9._\-]{12,}/g, "Bearer [REDACTED]"],
  ]],
  ["emails", [
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED]"],
  ]],
  ["names", [
    [/Guo Zhang/g, "[REDACTED]"],
    [/zhangguo/g, "[REDACTED]"],
  ]],
  ["hosts", [
    [/(?:[A-Za-z0-9\-]+\.)*quanttide\.(?:com|top)/g, "example.com"],
    [/(?:[A-Za-z0-9\-]+\.)*oss-cn-[a-z0-9\-]+\.aliyuncs\.com/g, "oss.example.com"],
    [/(?:[A-Za-z0-9\-]+\.)*[a-z0-9\-]+\.amazonaws\.com/g, "cloud.example.com"],
    // 桶名：本机已知清单（含 terraform state 桶），宁可多改不可漏改
    [/(?:qtclass-lite|qtclass-site|qtclass-studio|qtcloud-org-lite|qtcloud-org-studio|qtconsult-private|qtconsult-studio|qtgame-site|qtstore-site|qtstrategy-site|quanttide-terraform-state)/g, "[BUCKET]"],
    // 桶名兜底：任何 oss:// 引用（负向前瞻跳过自己写入的占位符，保证可重复检查）
    [/oss:\/\/(?!bucket\b)[a-z0-9][a-z0-9\-]*/g, "oss://bucket"],
  ]],
  ["paths", [
    [/\/home\/iguo/g, "/home/user"],
  ]],
];

const totals = Object.fromEntries(RULES.map(([name]) => [name, 0]));
const files = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();

for (const name of files) {
  const path = join(dir, name);
  const original = readFileSync(path, "utf8");
  let output = original;
  const perFile = {};

  for (const [category, rules] of RULES) {
    for (const [pattern, replacement] of rules) {
      pattern.lastIndex = 0;
      const matches = output.match(pattern);
      if (!matches) continue;
      perFile[category] = (perFile[category] ?? 0) + matches.length;
      totals[category] += matches.length;
      output = output.replace(pattern, replacement);
    }
  }

  if (output === original) continue;

  // 替换后逐行校验 JSON 仍合法，否则拒绝写入
  for (const line of output.split(/\r?\n/)) {
    if (line.trim()) JSON.parse(line);
  }

  if (checkOnly) {
    process.stdout.write(`${name} ${JSON.stringify(perFile)}\n`);
  } else {
    writeFileSync(path, output);
    process.stdout.write(`${name} ${JSON.stringify(perFile)}\n`);
  }
}

process.stdout.write(`${JSON.stringify({ mode: checkOnly ? "check" : "scrub", files: files.length, totals })}\n`);
if (checkOnly && Object.values(totals).some((n) => n > 0)) process.exitCode = 1;
