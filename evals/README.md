# 真实模型评测

这一层回答「换了模型或改了提示之后，真实任务做得怎么样」。它不在 `npm test`、`npm run verify` 或 CI 里运行，因为要花钱推理。

```bash
npm run test:evals -- --live                         # 用 .env 或环境里的 AEEIS_MODEL_BASE_URL、AEEIS_MODEL、AEEIS_MODEL_API_KEY
npm run test:evals -- --live --model <name>          # 换一个模型名，其余配置不变
npm run test:evals -- --live --case pdf --case pulse-md   # 按用例 id 或标签（pulse、pdf、r79）筛选
npm run test:evals -- --live --judge                 # 另用评审模型打分，见下文
npm run test:evals -- --fixture                      # 用本地 Fixture 模型走一遍，只检查评测本身能跑，不代表质量
npm run test:evals -- --list
npm run test:evals -- --compare <before.json> <after.json>
```

缺少 `AEEIS_MODEL_BASE_URL` 或模型名时，`--live` 写一份 `status: "not_run"` 的报告并以退出码 2 结束。**未运行不是通过。**

## 怎么跑一件用例

每件用例在进程内用构建好的运行时（`dist/`）和真实的 HTTP 模型适配器跑一件 Run，和服务端是同一套代码：

1. 按用例的 `request` 创建 Run，资料从仓库里的文件读取；
2. 只批准 Run 自己提出的那份计划（精确的 plan hash）；动作审批不代批，Run 停在那里就算结束；
3. 推进到结束、`needs_input`，或超过用例的时间预算；
4. 带 `followUp` 的用例在第一件成功后，在同一个 Thread 上追问，检查读追问那件 Run；
5. 用确定性检查打分，可选地再交给评审模型。

## 用例格式

`evals/cases/<id>.json`，`schemaVersion: "aeeis-eval-case/1"`：

| 字段 | 说明 |
| --- | --- |
| `id`、`title`、`source`、`tags` | `source` 指向它来自哪份复测集（`docs/pulse-retest-set.md`、`docs/fillable-pdf-retest-set.md`、`tests/fixtures/r79/`） |
| `request` | Run 请求（`goal`、`builtinSkill`、`maxModelCalls` 等）。资料可以是 `content`、文本 `file`、`file` 加 `encoding: "pdf"`，或 JSON `file` 加 `pointer`。`{{date:-10}}` 按 Run 时钟的当天换算 |
| `followUp` | 可选，第一件成功后的追问请求 |
| `budget.timeoutMs` | 整件用例的时间预算，默认 600 秒 |
| `checks` | 确定性检查，`required: false` 的只记录、不影响结果 |
| `judge.rubric` | 可选，给评审模型的评分标准 |

检查种类：

| `kind` | 通过条件 |
| --- | --- |
| `runStatus` | 状态在 `expect` 里（默认 `succeeded`）；`allowPartial: false` 时不接受部分结果 |
| `artifactType`、`artifactSchema` | 最后一份产物的类型，以及结构化内容符合 `project-pulse/1` 或 `fillable-pdf/1` |
| `evidenceResolvable` | 产物里所有证据引用都能对上这件 Run 收到的资料、产物、回执、PDF 输出或 Thread 历史 |
| `noPlaceholderRefs` | 没有 `[证据]`、`[evidence]` 这类占位，也没有 `TBD` 之类的引用 |
| `contentIncludes`、`contentExcludes` | 产物正文和结构化内容里包含 `all`／任一 `any`，或不包含（正则） |
| `toolUsed` | 用过某个工具，例如 `sources.csvQuery`、`pdf.fill` |
| `logProtocol` | 运行时打出的协议日志里有匹配的一条，例如 `aeeis-csv-date-filter/1` 里 `op: "lt"` 且 `effective: true` |
| `pdfFilled` | 填写的字段和值与预期一致；`exact` 时不能多填 |
| `pdfUnknowns` | 这些字段出现在 `unknowns` 里 |
| `withinBudget` | 在时间预算内结束，或以部分结果加明确限制结束 |
| `noRepair` | 没有触发产物修复（通常设为 `required: false`） |

## 评审模型

`--judge` 读取 `AEEIS_EVAL_JUDGE_BASE_URL`、`AEEIS_EVAL_JUDGE_MODEL` 和 `AEEIS_EVAL_JUDGE_API_KEY`，最好和被测模型不同。只对写了 `judge.rubric` 的用例打分，结果记在用例的 `judge` 字段（`pass`、`fail` 或 `unsure`，1–5 分和理由），**不参与**确定性结果。

## 报告

写到 `test-report/evals/<时间>-<live|fixture>-<模型>.json`（已被 git 忽略），`schemaVersion: "aeeis-eval-report/1"`：

- 模型 pin（模型、端点、提示版本）、git commit、用例列表和总体状态；
- 每件用例：状态、Run id、耗时、批准次数、按阶段的模型调用次数、输入和输出 token、费用（供应商没有报价时为 `null`）、各协议日志的条数、每项检查的结果和说明、可选的评审结果；
- 总计：通过数、token、调用次数、费用和耗时。

同一模型和用例跑两次，用 `--compare` 逐件、逐项对比：哪件用例的结果变了，哪项检查从通过变成失败，token 和耗时怎么变。

`--live` 的退出码：全部通过 0，有失败 1，未运行 2。`--fixture` 只在有用例出错或超时时返回 1，因为 Fixture 模型的答案本来就不该拿来判断质量。

## 和 RSI 的关系

同一批用例可以作为 RSI 回放套件的来源，但入口分开：这里不晋升、不激活任何候选，也不写 Brain。
