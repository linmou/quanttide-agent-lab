# 实验：会话脱敏导出（clean-session-curate）

> 目的：把 [clean-session-curate](https://github.com/linmou/clean-session-curate) 在本机完整跑一遍，产出可入公开仓的脱敏会话数据，并测出它在我们环境下的真实缺口，为智能体云是否接入提供实测依据。
> 日期：2026-11-19　对象：`/home/iguo/repos/quanttide` 下归属可证的 OpenCode 会话
> 上游：`linmou/clean-session-curate` main@`e0edc8f`（无 LICENSE 文件，故本仓不含其任何代码）；脱敏引擎 Capsule 1.0.0（Apache-2.0）
> 产物：[`data/session-scrub/`](../../data/session-scrub/)（9 份 `opencode_00N.jsonl` + `manifest.json`）

## 环境

| 项 | 实测值 |
| :-- | :-- |
| 系统 | Linux，Node v22.23.1，npm 10.9.8，`zip`/`unzip` 齐备 |
| 会话源 | opencode v2.0.30，`~/.local/share/opencode/opencode.db`（82,907,136 字节，47 条会话） |
| 原生会话根目录 | `~/.claude/projects`、`~/.codex/sessions`、`~/.copilot/session-state`、`~/.gemini/tmp` **四个都不存在** |
| Capsule | npm `@endorhq/capsule@1.0.0`（2026-02-11 发布），由 `npm ci --ignore-scripts` 装进 skill 本地 |

## 流程与实测结果

### 1. 安装与构建

```shell
git clone --depth 1 https://github.com/linmou/clean-session-curate /tmp/curate
cd /tmp/curate && npm run build
```

结果：`environment: ready`，19/19 测试通过（含环境准备、会话发现、路径清扫、打包四组）。这一步等价于其 CI 在 ubuntu/windows/macos 三平台跑的命令。

### 2. 发现会话：0 命中

```shell
node scripts/find_repo_sessions.mjs --target /home/iguo/repos/quanttide
# {"target":"/home/iguo/repos/quanttide","sessions":[],"skipped":0}
```

两个原因，缺一个都不会是 0：

1. 本机没有四个原生会话根目录（上表），Claude/Codex/Copilot/Gemini 一路无源可扫；
2. **opencode v2.0.30 没有 `db` 子命令**。技能写的是 `opencode db path` 与 `opencode db "SELECT id, directory FROM session"`，本机 `opencode --help` 的子命令只有 `session`、`api`、`debug`、`auth`、`mcp`、`plugin`、`models`、`stats`、`mini`、`run`、`service`、`reload`、`pair`、`serve` 等，没有 `db`；脚本把异常吞掉，于是 OpenCode 一路静默返回空，`skipped` 也是 0——**不报错，只是什么都不发现**。

绕行两法（本实验用前者）：

- 只读查询：`sqlite3.connect("file:...?mode=ro", uri=True)` 执行 `SELECT id, directory FROM session`，不写不复制库文件；
- `opencode session list --format json`（须在目标目录下运行，返回里带 `directory`），但它只列当前项目的顶层会话，子目录项目要逐个目录跑。

按目录包含判定（词法 + `realpath` 双份、按路径段比对）：47 条中 **9 条归属可证**，38 条排除——`/home/iguo`（8）、`/home/iguo/repos`（7，是目标的父目录而非其内）、`~/.hermes/cache/scratch`（23）。其中 5 条记录的目录 `…/quanttide/default/quanttide-tech` 在盘上已不存在（现为 `defaults/`），走的是目录缺失时的词法包含兜底。

### 3. 导出会话副本

```shell
opencode session export <sessionId> > <隔离目录>/<sessionId>.json
```

9 份共 1,712 KB，结构为 `{info, messages}`；消息类型只有 `user` / `assistant` / `system`，内容块只有 `text` / `reasoning` / `tool`。原始库只用 `mode=ro` 打开过。

### 4. 转换为 Capsule 可识别格式

[`convert.mjs`](convert.mjs)（本实验自写，非上游代码）把 `{info, messages}` 转成 Claude Code JSONL：保留事件顺序、角色、时间戳、工具调用与结果、正文与 `cwd`；不写会话 id、消息 id、`cost`、`snapshot`、`finish`；工具 id 重排为匿名连续号 `tool_NNN`，会话 id 用 `session_00N`。

两个必须踩到的点：

- **必须带 `sessionId`**。Capsule 的 `detectFormat` 只认「有 `sessionId` 且 `type` ∈ {user, assistant, file-history-snapshot}」的行，否则判 `unknown`，交互菜单会退回让你手选格式。
- **Capsule 声明了 opencode 格式但没实现**。其 `AgentFormat` 类型里有 `'opencode'`，`parseSession()` 对它直接抛 `Parser for "opencode" is not yet implemented`，`detectFormat` 也识别不了——所以「转成 Claude JSONL」不是权宜之计，是唯一通路。

结果：9 份共 1,210 KB。

### 5. Capsule 匿名化（Select all）

```shell
( sleep 3; printf ' '; sleep 2; printf '\r'; sleep 2; printf '\r'; sleep 3 ) | \
  script -qec "npm exec --prefix /tmp/curate -- capsule export <转换文件>" /dev/null
```

菜单是交互式的，无 TTY 时进程直接走 cancel 分支退出且不报错，所以用 `script` 开伪终端驱动：空格选中首项 `Select all`，回车确认，回车接受默认输出名。

七项开关全部生效，实测（对 329 行的 `opencode_001`）：

| 检查项 | 结果 |
| :-- | :-- |
| `thinking` 块 | 0 |
| 工具输出 | 全部变成 `[removed]`（161 处） |
| `usage` token 用量键 | 0 |
| `system` 行 | 0 |
| `cwd` | `/home/iguo/…` → `/project/src/file1` |
| 绝对路径 `/home/` | 0 |
| 体积 | 1,210 KB → 235 KB |

### 6. 二次自查：抓到一处密钥漏网（本实验最重要的一条）

七项全开之后，`opencode_006` 里仍有 **3 处真实 API key**（`sk-…`）加 1 处 `Bearer sk-…`，分别落在：

| 位置 | 形态 |
| :-- | :-- |
| 用户正文 | 用户把 `deepseek v4-flash sk-…` 直接粘进了对话 |
| 工具入参 | 写配置文件的 heredoc，含 `OPENAI_API_KEY` |
| 工具入参 | `curl … -H "Authorization: Bearer sk-…"` |

Capsule 的路径遮蔽只认路径样式的字符串，密钥原样通过——其 README 的免责条款在我们自己的数据上成立。处理：整串精确替换为 `[REDACTED]`（3 处），然后按八类模式全量复扫，除占位符外 **0 命中**：

```text
密钥形态(sk/ghp/AKIA/xox/飞书hook) · 密钥字段赋值 · Bearer 凭证 · 私钥块 ·
家目录与用户名 · 任意绝对路径 · 邮箱 · IP地址(仅命中 127.0.0.1，保留)
```

### 7. 路径残留清扫与打包

```shell
node scripts/scrub_export_paths.mjs --root /home/iguo/repos/quanttide --export-dir <导出目录>
node scripts/package_export.mjs --root <工作根> --export-dir <导出目录> --output <工作根>/session-export.zip
```

- 清扫：`{"files":10,"changed":0}`（Capsule 已清干净；复跑一次为 0，确认幂等）。脚本只在有残留时才写盘，有残留则整体不写。
- 打包：`{"archive":"session-export.zip","engine":"zip","files":10}`，`unzip -tqq` 通过，成员恰好是 9 份编号 jsonl + `manifest.json`。

### 8. 原始数据源的哈希

实验期间源库字节哈希变过一次（`e358911f…` → `62d27158…`），发生在首次批量导出前后，为 opencode 后台服务写入或 WAL 落盘。随后做受控复测，三步哈希均不变：

| 动作 | 哈希 |
| :-- | :-- |
| 只读 `mode=ro` 查询 | 不变 |
| `opencode session list` | 不变 |
| `opencode session export` | 不变 |

结论：本实验没有写过源库，但**源库是活的**，「源文件哈希不变」这条保证在 SQLite 源上不能按字节硬套。

## 产物

`data/session-scrub/`，204 KB（原始导出 1,712 KB 的 11.9%）：

| 文件 | 说明 |
| :-- | :-- |
| `opencode_001.jsonl` … `opencode_009.jsonl` | 匿名连续编号，不含标题、会话 id、目录名 |
| `manifest.json` | `format_version=2`、`session_count=9`、`agents={"opencode":9}`、`ux_language=zh`、`cleaning=capsule-select-all`、`capsule_version=1.0.0` |

`ux_language` 取 `zh` 的依据：用户消息与助手回答的主导语言是中文（正文里的拉丁字符多为引用的英文项目介绍与命令，不是对话语言）。

中间产物（未入仓、含未脱敏内容）在 `/tmp/exp/`：`raw/` 原始导出、`converted/` 转换副本、`work/session-export.zip` 打包件，用完即弃。

## 复现

```shell
# 1 构建
git clone --depth 1 https://github.com/linmou/clean-session-curate /tmp/curate && (cd /tmp/curate && npm run build)
# 2 发现（本机 opencode 无 db 子命令，改用只读查询拿到 9 个 id）
python3 -c "import sqlite3,os;p=os.path.expanduser('~/.local/share/opencode/opencode.db');print(sqlite3.connect(f'file:{p}?mode=ro',uri=True).execute('SELECT id,directory FROM session').fetchall())"
# 3 逐个导出
opencode session export <id> > /tmp/exp/raw/<id>.json
# 4 转换
node experiments/session-scrub/convert.mjs --in /tmp/exp/raw --out /tmp/exp/converted
# 5 匿名化（9 次，见上文 TTY 驱动写法）→ 6 清扫 → 7 写 manifest → 8 打包
```

## 对智能体云的三条结论

1. **形态可用**：「本地清洗 → 打包 → 上传」让原始会话不出本机，产出物只有计数与语言标签，作为客户端侧步骤是成立的。
2. **发现层在我们环境失效**：四个原生根目录本机没有，opencode 的 `db` 子命令在 v2.0.30 已不存在，且**失败是静默的**（返回空、`skipped=0`）。接入前必须先补发现层，并让「发现为 0」变成显式告警而不是空结果。
3. **Capsule 只能当第一道**：七项开关对路径、身份、工具输出有效，对正文与工具入参里的密钥无效（本实验 3 处漏网实证）。第二道自查（密钥/敏感串扫描 + 精确替换）不能省，云端验收也应按这一道来卡。
