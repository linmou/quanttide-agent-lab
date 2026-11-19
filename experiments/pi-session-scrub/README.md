# 实验：pi 会话接入清洗流水线（含第二道清扫）

> 目的：clean-session-curate 完全不认识 pi 会话，而 pi 是本领域的主要 session 源。本实验把 pi 会话接进同一条清洗流水线，并把实验 1 提出的改进「第二道清扫机器强制」落地成脚本，测出它到底要拦多少东西。
> 日期：2026-11-19　对象：`/home/iguo/repos/quanttide` 下归属可证的 pi 会话
> 上游：`linmou/clean-session-curate` main@`e0edc8f`（Capsule 1.0.0 做第一道）；第二道 `scrub.mjs` 为本实验自写
> 产物：[`data/pi-session-scrub/`](../../data/pi-session-scrub/)（20 份 `pi_00N.jsonl` + `manifest.json`，4.7 MB）

## 环境

| 项 | 实测值 |
| :-- | :-- |
| 会话源 | `~/.pi/agent/sessions/<slug>/<时间戳>_<uuid>.jsonl`，共 364 个文件、93 个工作目录 |
| pi 会话结构 | 首行 `{type:"session", cwd, id, timestamp, version}`，其后 `model_change` / `thinking_level_change` / `message`；消息 `role` ∈ {user, assistant, toolResult}，内容块 `text` / `thinking` / `toolCall` |
| 清洗引擎 | Capsule 1.0.0（同实验 1） |
| 体积链 | 25.6 MB → 18.2 MB → 4.71 MB（保留 18.4%） |

## 流程与实测结果

### 1. 发现：归属判定比 OpenCode 干净

pi 会话首行自带 `cwd`，不必像实验 1 那样靠目录名反推。逐个读首行做目录包含判定：

| 结果 | 数量 |
| :-- | :-- |
| 会话文件总数 | 364 |
| 首行无 `cwd` 或解析失败 | 1 |
| **归属可证（cwd 在目标目录内）** | **250（191.1 MB）** |
| 归属不可证（排除） | 113 |
| 涉及工作目录 | 68 |

被排除的是 `/home/iguo`、`/home/iguo/repos` 这类父目录与其它项目——照旧一条不收。

### 2. 采样

250 条 191 MB 全跑既慢也没必要，采样规则写死以便复现：**68 个工作目录按字母序等距取 20 个（步长 3），每个取该目录下最新 1 条**，共 20 条、25.6 MB。其中 1 条在实验当天仍在被写入（mtime 2026-11-19），转换取的是执行时刻的快照。

### 3. 转换：pi → Claude JSONL

[`convert.mjs`](convert.mjs)（本实验自写）按实验 1 同样的约定转换：

- `user` / `assistant` / `toolResult` 三类角色 → `user` 行、`assistant` 行、带 `tool_result` 块的 `user` 行（配对靠 `toolCallId`，重排为匿名连续号 `tool_NNN`）
- `thinking` → `thinking` 块、`toolCall` → `tool_use` 块、`usage` → Claude 的四个 token 键、`model` 照抄
- 会话 id、消息 id、`responseId`、`stopReason`、`cost`、`compaction`、`model_change` 一律不写；会话 id 用 `session_NNN`
- 每行带 `sessionId`（Capsule 的格式探测要求前 10 行内出现它）与 `cwd`（权威项目位置，交给 Capsule 遮蔽）

结果：20 份共 18.2 MB，逐行 JSON 合法。

### 4. Capsule 匿名化（Select all，同实验 1 的 TTY 驱动写法）

25.6 MB → 4.71 MB。七项开关效果与实验 1 一致：`thinking` 归零、工具输出全变 `[removed]`、`usage` 键归零、`cwd` 变 `/project/src/fileN`。

**但漏了一处**：`pi_007` 里有一条 `/home/iguo/repos/quanttide/defaults/…/ROADMAP.md` 原样通过。原因是它落在数组元素里——Capsule 的 `maskPathsInObject` 只递归普通对象，遇到数组直接原样返回（源码 `packages/cli/src/anonymize.ts`）。实验 1 的 opencode 工具入参都是对象，所以没暴露这个盲区。

### 5. 第二道清扫（本实验新增，落地实验 1 的改进 3）

[`scrub.mjs`](scrub.mjs)：Capsule 之后对清洗产物做模式扫描与精确替换，命中只记数量不记内容，替换后逐行校验 JSON 仍合法；`--check` 模式只扫不写、有命中即非零退出，可当回归用。

```shell
node experiments/pi-session-scrub/scrub.mjs --dir <清洗目录>          # 扫描并替换
node experiments/pi-session-scrub/scrub.mjs --dir <清洗目录> --check  # 回归：有命中即失败
```

实测命中 **1014 处**：

| 类别 | 命中 | 是什么 |
| :-- | --: | :-- |
| `hosts` | 701 | 部署域名（`*.quanttide.com` / `*.quanttide.top`）与 OSS 桶名（`qtclass-lite`、`qtgame-site`、`quanttide-terraform-state` 等 11 个桶，含 `oss://<桶>` 引用与阿里云 OSS/CDN 源站域名） |
| `emails` | 159 | `user.email` 提交命令里的企业邮箱 |
| `names` | 153 | 同一批提交命令里的 `user.name` 真名 |
| `paths` | 1 | 上一节那条数组里的 `/home/iguo/…` |
| `secrets` | 0 | 本批 pi 会话没扫到密钥 |

改写后复扫：域名、桶名、邮箱、人名、家目录路径全部 0；8362 行 JSON 全部解析通过。

> 踩到一个坑：模式原本带 `\b` 词边界，但会话正文在 JSON 里是转义串，`\n` 的 `n` 是词字符，行首的词会被 `\b` 挡在门外——第一版漏掉了 `pi_007` 里一处行首桶名 `qtclass-studio`，靠不带边界的裸扫复核才发现。脚本里的模式现已全部去掉 `\b`，收尾也固定成「裸扫一遍已知敏感词」。

`manifest.json` 在实验 1 的六项之外加了 `redactions` 计数（只记数量），把第二道的战果留在清单里：

```json
{"format_version":2,"session_count":20,"agents":{"pi":20},"ux_language":"zh","cleaning":"capsule-select-all","capsule_version":"1.0.0","redactions":{"secrets":0,"emails":159,"names":153,"hosts":701,"paths":1}}
```

`ux_language` 取 `zh`：清洗后正文汉字占 62.2%，用户消息占 60.7%，明显主导（实验 1 是 34.9%，当时按对话语言判 `zh`）。

### 6. 打包与源文件保护

- 打包：`session-export.zip`，21 个成员（20 份 jsonl + manifest），`unzip -tqq` 通过。
- 源文件只读：`convert.mjs` 只用 `readFileSync`，20 个源文件 mtime 全部是历史日期（1 条为当天仍在写的会话），实验期间未写入任何 pi 会话文件。

## 产物

`data/pi-session-scrub/`，4.7 MB：

| 文件 | 说明 |
| :-- | :-- |
| `pi_001.jsonl` … `pi_020.jsonl` | 按采样规则编号，不含会话 id、目录名、人名、邮箱、域名、桶名 |
| `manifest.json` | 六项标准字段 + `redactions` 计数 |

中间产物（未入仓、含未清扫内容）在 `/tmp/pi-exp/`：`converted/` 转换副本、`work/session-export.zip` 打包件。

## 复现

```shell
# 1 发现：读每个会话首行的 cwd，判定是否在目标目录内
python3 -c "import glob,json,os;[print(os.path.dirname(f)) for f in glob.glob(os.path.expanduser('~/.pi/agent/sessions/*/*.jsonl')) if json.loads(open(f).readline()).get('cwd','').startswith('/home/iguo/repos/quanttide')]"
# 2 采样（写进 sample.txt）→ 3 转换
node experiments/pi-session-scrub/convert.mjs --list sample.txt --out converted/
# 4 匿名化：对每份跑 capsule export + Select all（TTY 驱动写法见实验 1）
# 5 第二道清扫 + 回归
node experiments/pi-session-scrub/scrub.mjs --dir session-export
node experiments/pi-session-scrub/scrub.mjs --dir session-export --check   # 应 0 命中
# 6 写 manifest → 7 打包
```

## 对智能体云的四条结论

1. **pi 必须自备转换**：Capsule 的格式清单里没有 pi，clean-session-curate 的发现层也不扫 `~/.pi`。接进来的第一件事是把「pi → Claude JSONL」这一步固化（本实验的 `convert.mjs` 是可用起点）。
2. **第一道有已证实的盲区**：数组元素里的绝对路径不被遮蔽（源码不递归数组）。这一处不能靠调开关解决。
3. **第二道不是可选项**：1014 处命中里 99.9% 是域名、桶名、人名、邮箱——全是 Capsule 结构上不管的类别；密钥反而 0 命中。所以「Capsule 之后必须有模式清扫」这一步，拦的主要不是密钥，是身份与部署信息。
4. **两类会话的漏网分布不同**：实验 1 的 9 条 opencode 会话漏 3 处密钥、0 处域名；本实验 20 条 pi 会话漏 0 处密钥、1014 处身份与部署信息。漏什么取决于会话内容，不取决于工具——所以清扫规则必须按类别覆盖全，不能按上次命中过的类别补。
