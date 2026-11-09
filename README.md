# resource-guard

[English](#english) · [中文](#中文)

A resource gate for **DeepSeek Harness**: it estimates a tool call's memory and VRAM cost *before* the call runs, asks for confirmation when the call would be heavy, and feeds a live hardware budget into every session so the model plans concurrency against the real machine instead of guessing.

---

## English

### Why this exists

On 2026-11-09 a single command — `py -3.12 align_parallel.py` — hid `max_workers=6` inside the file. Six `qwen3-aligner` processes at roughly 6 GB of commit each, on top of a running game and a video editor, exhausted a 66.9 GB commit limit in eight seconds. DWM crashed, Explorer hung, the desktop froze, and the session died mid-turn.

The command line looked harmless. The damage was invisible until the machine was already gone.

### What it does

| Mechanism | Hook | Behaviour |
| --- | --- | --- |
| Pre-flight gate | `tools/pre-execute` | Estimate peak → compare with current headroom → `allow` / `ask` / `deny` |
| Runtime breaker | 1 s sampling + `tools/post-execute` | On a breach, append a warning to the tool result and tell the model to converge concurrency |
| Budget injection | `systemPrompt.context` | Per-step memory / VRAM / safe-concurrency block |
| Profile learning | local JSON | Records the measured increment per signature; estimates improve with use |

### How the estimate is built

1. **Explicit signals on the command line** — `max_workers=6`, `-j 8`, `xargs -P`, `-ThrottleLimit`.
2. **The contents of referenced scripts** — when the command names a `*.py|ps1|sh|js|bat|cmd` file that exists and is ≤ 1 MB, the first 64 KB are scanned for worker counts, binary names and torch/onnx markers. This is the layer built specifically for the incident above: the concurrency was *not* on the command line.
3. **Per-binary unit costs** — `qwen3-aligner` 6 GB/process (measured on this machine), Python + torch 3.2 GB, `ffmpeg` 1.2 GB, `ollama` scaled by model size.
4. **History** — once a signature has run, the measured increment corrects the rule estimate.

### Installation

This is a local bundle, not a published npm package. The profile links to the checkout directory, so put it somewhere stable — not a temporary folder or a session workspace.

1. Clone it:
   ```bash
   git clone https://github.com/wth373737/dsh-resource-guard.git
   ```
2. Install the bundle into the running profile **by absolute directory path** — through the plugin manager's `install_bundle`, or by asking the agent to do it with that path.
3. **Restart DeepSeek Harness once.** Replacing an installed package only loads a fresh module generation on restart.
4. Confirm it is live: the next request's system context carries a resource-budget block (currently Chinese) with commit, VRAM and a suggested concurrency.

To update: `git pull` in the checkout, then restart. The profile keeps pointing at that directory, so nothing needs reinstalling.

### Configuration

Set these under `config` in the bundle's `cordis.patch.yml`; the plugin manager reloads them.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `mode` | `ask` | `ask` to prompt, `deny` to refuse outright, `warn` to record only |
| `scope` | `heavy` | `heavy` gates known-expensive tools, `all` gates every call |
| `reserveGb` | `6` | Headroom reserved when judging physical pressure |
| `askRatio` | `0.8` | Projected commit / limit that triggers a question |
| `denyRatio` | `0.94` | Projected commit / limit that triggers a refusal |
| `vramAskRatio` | `0.85` | VRAM question threshold |
| `vramDenyRatio` | `0.97` | VRAM refusal threshold |
| `minEstimateGb` | `4` | Estimates below this are never gated |
| `perWorkerGb` | `3.2` | Assumed peak commit of one worker when sizing safe concurrency; replaced by the measured median once history holds ≥ 3 samples |
| `breaker` | `true` | Runtime monitoring |
| `breakerRatio` | `0.92` | Observed commit ratio that counts as a breach |
| `injectBudget` | `true` | Inject the live budget block |
| `learn` | `true` | Feed measured peaks back into the estimator |
| `autoTune` | `suggest` | `off` / `suggest` (write the rationale document only) / `apply` (also write the recommended values into this config) |
| `tools` | `[]` | Extra tool names always treated as heavy |
| `debug` | `false` | Also log to stderr |

### Settings page

Installing the bundle adds **Settings → Resource Guard**.

That page is contributed by the bundle's **client half** (`dsh.client` + `client.js`), not generated from the Host config: everything under Settings is registered by client plugins into `settings.section`, so a Host-only plugin gets no page at all — its configuration exists but nothing can show or change it. v0.3.0 adds the client half for that reason.

The page shows the live budget (commit, VRAM, safe concurrency), the hardware-derived suggestion with a *fill recommended values* action, and every threshold as an editable field with its explanation. It reads and writes through a fenced same-origin route (`/resource-guard/api`, requiring the `x-resource-guard-ui` header) that calls the settings service on the Host, so saved values land in the profile config exactly like a hand edit.

After installing a new version, refresh the page once — the client bundle is loaded at boot.

### Recommendation document

At startup the plugin measures the machine and writes `$DSH_HOME/resource-guard/recommendation.md`: the recommended thresholds plus, for every one, the hardware fact it came from. For example:

> `askRatio` → 0.78 — commit limit 66.9 GB ÷ 62.9 GB physical = 1.06, page file only 4 GB, so there is almost no overflow room and the ask line drops to 78%.

`autoTune: suggest` (the default) only writes that document. `apply` also writes the values into this config once per hardware fingerprint, recorded in `applied.json`; `off` skips the whole step.

### State

`$DSH_HOME/resource-guard/`

- `history.json` — measured peaks per signature. Safe to delete; losing it only falls back to rule-only estimates.
- `recommendation.md` — the hardware-derived suggestions for this machine, regenerated at each start.
- `applied.json` — the hardware fingerprint of the last `autoTune: apply` run.
- `guard.log` — latest run log, rotated at 512 KB.

### Known limits

- **Opaque commands are still guessed.** If concurrency is computed at runtime (read from a config, derived from CPU count), static analysis cannot see it. The runtime breaker is the backstop.
- **VRAM is sampled slowly.** One `Get-Counter` measurement blocks for 1–1.5 s, so VRAM refreshes every 10 s and memory every 3 s. Short spikes can be missed.
- **No hard kill.** v1 warns and asks the model to converge. Safely killing *only* the processes a call spawned needs process-tree ownership; killing the wrong PID is worse than the incident. Deferred to v2.
- **Schema loading is best-effort.** The settings page needs the Harness's own `schemastery`; when it cannot be resolved the plugin still runs, just without the form.
- **Two persistent PowerShell samplers**, roughly 40–60 MB each.
- **The injected budget block is Chinese only.** The prompt context exposes no UI locale, so the block is not localized yet.

### Requirements

DeepSeek Harness with the plugin manager; Windows (the samplers use `GlobalMemoryStatusEx` and WDDM performance counters).

### Uninstall

Remove the `@local/dsh-resource-guard` bundle in the plugin manager, then delete `$DSH_HOME/resource-guard/`.

### License

MIT © 2026 wth373737 — see [LICENSE](LICENSE).

---

## 中文

### 为什么有这个东西

2026-11-09，一条 `py -3.12 align_parallel.py` 的命令，把 `max_workers=6` 藏在了文件里。六个 `qwen3-aligner` 进程、每个约 6 GB 提交内存，加上当时正在跑的游戏和剪辑软件，八秒内击穿了 66.9 GB 的提交上限。DWM 崩溃、资源管理器挂起、桌面冻住，会话在中途死掉。

命令行看上去人畜无害。等发现的时候，机器已经没了。

### 它做什么

| 机制 | 挂点 | 行为 |
| --- | --- | --- |
| 事前门禁 | `tools/pre-execute` | 估算峰值 → 与当前余量比较 → `allow` / `ask` / `deny` |
| 运行时熔断 | 1 秒采样 + `tools/post-execute` | 越线时在工具结果里追加告警，并要求模型收敛并发 |
| 预算注入 | `systemPrompt.context` | 每步可见的内存 / 显存 / 安全并发 |
| 画像学习 | 本地 JSON | 按签名记录实测增量，越用越准 |

### 估算怎么来

1. **命令行的显式信号** —— `max_workers=6`、`-j 8`、`xargs -P`、`-ThrottleLimit`。
2. **读被引用脚本的内容** —— 命令行里出现存在且 ≤ 1 MB 的 `*.py|ps1|sh|js|bat|cmd` 文件时，读前 64 KB 继续找并发数、二进制名和 torch/onnx 标记。这一层就是为上面那次事故加的：并发数根本不在命令行里。
3. **按二进制给单价** —— `qwen3-aligner` 6 GB/进程（本机实测）、Python + torch 3.2 GB、`ffmpeg` 1.2 GB、`ollama` 按模型规模。
4. **历史回填** —— 同一签名跑过之后，用实测增量修正规则估算。

### 安装

这不是发到 npm 的包，而是一个本地 bundle：profile 直接链接到仓库目录，所以别放在临时目录或会话工作区里。

1. 克隆：
   ```bash
   git clone https://github.com/wth373737/dsh-resource-guard.git
   ```
2. 在运行中的 profile 里，用**绝对目录路径**安装（插件管理器的 `install_bundle`，或让代理代劳）。
3. **重启一次 DeepSeek Harness**。替换已安装的包，只有在重启后才会加载新的模块代。
4. 确认生效：下一次请求的系统上下文里会出现资源预算区块（提交 / 显存 / 建议并发）。

更新：在克隆目录里 `git pull`，然后重启。profile 仍然指向同一个目录，不需要重装。

### 配置

写在 bundle 的 `cordis.patch.yml` 的 `config` 下，由插件管理器重载。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `mode` | `ask` | `ask` 询问 / `deny` 直接拒 / `warn` 只记录不拦 |
| `scope` | `heavy` | `heavy` 只管网关工具 / `all` 全部工具 |
| `reserveGb` | `6` | 判断物理内存压力时保留的余量 |
| `askRatio` | `0.8` | 预计提交/上限 超过此比例就询问 |
| `denyRatio` | `0.94` | 超过此比例直接拒绝 |
| `vramAskRatio` | `0.85` | 显存询问线 |
| `vramDenyRatio` | `0.97` | 显存拒绝线 |
| `minEstimateGb` | `4` | 低于此估计不打扰 |
| `perWorkerGb` | `3.2` | 计算安全并发时假定的单进程峰值；历史样本 ≥ 3 条后被实测中位数替代 |
| `breaker` | `true` | 运行时监控 |
| `breakerRatio` | `0.92` | 运行中提交占比警戒线 |
| `injectBudget` | `true` | 是否注入预算区块 |
| `learn` | `true` | 是否回填历史 |
| `autoTune` | `suggest` | `off` / `suggest`（只生成依据文档）/ `apply`（同时把推荐值写进配置） |
| `tools` | `[]` | 额外强制纳入门禁的工具名 |
| `debug` | `false` | 同时写 stderr |

### 设置页

装上 bundle 之后，**设置 → 资源门禁** 会出现一个页面。

这个页面由 bundle 的**客户端半边**（`dsh.client` + `client.js`）注册，**不是**从 Host 配置自动生成的：设置里的每个页面都由客户端插件注册到 `settings.section`，只有 Host 半边的插件根本不会出现在那里——配置存在，但没有任何东西能显示或修改它。v0.3.0 补上客户端半边就是为了这件事。

页面显示实时预算（提交内存、显存、安全并发）、硬件推导建议（带「填入推荐值」），以及每个阈值的可编辑字段和说明。读写走一条带自定义头的同源路由（`/resource-guard/api`，要求 `x-resource-guard-ui`），由它调用 Host 的 settings 服务，所以保存的值和手改配置完全等价。

装新版本后刷新一次页面——客户端 bundle 在启动时加载。

### 配置依据文档

插件在启动时实测本机硬件，写出 `$DSH_HOME/resource-guard/recommendation.md`：推荐阈值，以及**每一条阈值来自哪项硬件属性**。例如：

> `askRatio` → 0.78 —— 提交上限 66.9 GB ÷ 物理 62.9 GB = 1.06，分页文件只有 4 GB，几乎没有溢出空间，所以询问线压到 78%。

`autoTune: suggest`（默认）只生成这份文档；`apply` 会在硬件指纹变化后把上表写进配置，记录在 `applied.json`；`off` 完全跳过。

### 状态文件

`$DSH_HOME/resource-guard/`

- `history.json` —— 每个签名的实测峰值，可随时删，删了只是退回纯规则估算。
- `recommendation.md` —— 本机的硬件推导建议，每次启动重新生成。
- `applied.json` —— 最近一次 `autoTune: apply` 的硬件指纹。
- `guard.log` —— 最近运行日志，超过 512 KB 自动轮转。

### 已知边界

- **不透明命令仍然只能猜**：并发数若由运行时计算（读配置、按 CPU 核数动态决定），静态分析看不到，靠运行时熔断兜底。
- **显存是慢采样**：一次 `Get-Counter` 要 1–1.5 秒，所以显存每 10 秒更新、内存每 3 秒，瞬时尖峰可能被漏掉。
- **没有硬杀**：v1 只告警并请模型自行收敛。安全地只杀掉某次调用派生的进程需要进程树归属，误杀的代价比事故更大，留到 v2。
- **Schema 加载是尽力而为**：设置页依赖 Harness 自己的 `schemastery`；解析不到时插件照常运行，只是没有表单。
- **两个常驻 PowerShell 采样进程**，各约 40–60 MB。

### 环境要求

带插件管理器的 DeepSeek Harness；Windows（采样依赖 `GlobalMemoryStatusEx` 与 WDDM 性能计数器）。

### 卸载

插件管理器里移除 `@local/dsh-resource-guard` 这个 bundle，再删掉 `$DSH_HOME/resource-guard/`。

### 许可

MIT © 2026 wth373737，详见 [LICENSE](LICENSE)。
