# V2EX DSH Client

这是一个面向 DeepSeek Harness（DSH）的只读 V2EX 插件，提供登录后的主题浏览、AI 摘要、兴趣推荐，以及能力一致且有边界的 Agent Tools。

## 环境与安装

- Node.js 22 或更高版本
- DSH `>=0.2.1-rc.5 <0.3.0`
- V2EX Personal Access Token（PAT）

把本包安装到 DSH 工作区，并在插件 bundle 中启用 `v2ex-dsh-client`。本地源码可执行：

```bash
pnpm install
pnpm build
pnpm pack
```

通过当前 DSH 使用的包管理流程安装生成的包。Host 入口为 `v2ex-dsh-client`，浏览器入口为 `v2ex-dsh-client/client`；包内的 `dsh.plugin.json` 与 `cordis.patch.yml` 提供 bundle 元数据。

## 登录

在 V2EX 账户设置中创建 PAT，打开 DSH 的 V2EX 侧边栏并粘贴到表单。Host 会先验证，再保存到 DSH credentials 服务。Token 不会进入插件配置、内容存储、浏览器存储、模型提示词、Agent Tool 结果或日志。替换 Token 会先验证新凭据，成功后才切换账户。退出时可选择清除本地兴趣和推荐数据。

## 只读保证

插件发往 V2EX 的所有请求都固定使用 `GET`，且仅访问 V2EX 官方 HTTPS API 域名。可读取 Token 状态、会员身份、最新/热门/节点主题、主题详情和回复。插件不能发布或修改主题与回复，也不能感谢、收藏、忽略、屏蔽、提升、删除或执行其他 V2EX 写操作。

侧边栏会通过同源 Host 路由修改本地设置和状态。这些本地 `POST`、`PUT`、`DELETE` 不会成为 V2EX 写请求。所有 Agent Tools 同样只读。

## 浏览与 AI

Latest、Hot、Nodes 支持主题和分页回复浏览。内容会经过结构校验、大小限制与缓存；陈旧缓存会明确标记。AI 摘要需要显式触发，并展示主题及回复页覆盖范围。AI 服务不可用时，普通浏览仍可使用。

V2EX 内容一律作为不可信输入。只有有界的规范化内容会交给 DSH 当前模型；模型调用不开放工具，结构化输出会被校验。AI 结果可能不完整或不准确，应以原始讨论为准。

## 兴趣学习与隐私

历史学习默认关闭，只有在 Interest 页面明确授权后才启动。插件仅选取有限的用户纯文本消息，并排除系统、助手、工具、附件、疑似凭据与内部元数据。原始历史不会存储，只持久化可检查、可编辑的结构化档案。

用户可以编辑标签、偏好节点和排除项，暂停自动学习，手动重新学习，撤销授权或清空档案。撤销后不会再读取历史。兴趣、设置、推荐、已读状态和反馈均按已验证 V2EX 账户隔离。

## 刷新、限额与提醒

后台刷新仅在 DSH Host 运行时工作。默认每 30 分钟刷新一次，扫描最新列表和偏好节点最多两页。本地过滤先于有预算上限的 AI 排序；交互读取优先，接近 V2EX 返回的速率限额时会暂停后台任务。

Settings 可配置刷新周期、节点、每来源页数、AI 候选预算、提醒阈值，以及带 IANA 时区的安静时段。安静时段会停止提醒投递，但仍可能刷新本地推荐。

提醒只投递给合适且活跃的顶层 DSH Agent。没有可用 Agent 或 Agent 忙碌时，提醒可能保持待投递，并在 Host 运行期间重试。它不是操作系统通知，DSH 退出后不保证继续投递。

## 配置

正常运行没有 Token 配置字段或环境变量。认证仅通过侧边栏和 DSH credentials 服务完成；运行选项位于 Settings 与 Interest。`V2EX_TEST_TOKEN` 仅供维护者选择性运行实时验证，插件运行时和确定性发布门禁都不会使用它。

## 故障排查

- **登录被拒绝：** 重新创建 PAT、检查有效期，并去掉粘贴内容首尾空白。
- **显示离线或陈旧：** V2EX 暂时不可达，当前展示最后一次有效缓存；联网后重试。
- **速率受限：** 等待服务端提示的重置时间；后台任务会为交互读取保留额度。
- **AI 不可用：** 在 DSH 配置当前模型；普通浏览不依赖 AI。
- **历史学习不可用：** 安装 DSH history-query 服务，然后显式授权。
- **没有提醒：** 检查安静时段、阈值、未读项和可接收消息的活跃顶层 Agent。
- **账户数据错误：** 退出时选择清除个人数据，再登录正确账户。

对外错误只包含稳定错误码，不暴露提供方原始诊断。

## 开发与发布验证

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm verify:package
pnpm verify:release
```

`verify:release` 是确定性的，不访问 V2EX。实时冒烟测试需要明确选择，并通过进程环境提供 PAT：

```bash
V2EX_TEST_TOKEN='<请在共享 shell 历史之外设置>' pnpm verify:live-api
```

实时验证器只执行 Token、会员、最新主题第一页、选中主题及回复的 GET 读取；请求有超时和响应大小限制，输出仅包含稳定 JSON 字段或错误码。不要提交 PAT，也不要把 PAT 作为命令行参数。

## 许可证

MIT，详见 [LICENSE](./LICENSE)。
