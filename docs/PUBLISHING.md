# 发布养鱼

当前是本地 **0.2.0 未发布版本**。本文是维护者操作说明，编写文档不代表已经发布到 npm、GitHub 或任何插件市场。`dsh-yangyu` 的 npm 名称占用情况尚未核查；作者和公开仓库尚未填写。

## 发布前确认

1. 由实际维护者建立公开 GitHub 仓库，填写 `package.json` 的真实 `author`、`repository`、`homepage`、`bugs`，保留已有 MIT 许可与第三方署名。不要把示例账号或推测的身份写成作者。
2. 确认 npm 包名与发布账号权限；可执行 `npm view dsh-yangyu name version` 查询。网络失败不代表名称可用。名称已占用时，选本人有权发布的名称，并同步修改 manifest、exports 引用与 `cordis.patch.yml` 中的包名。
3. 核对 `dsh.bundle`、`dsh.client`、入口文件和 DSH / Node 版本范围。其他人设和生活插件不是强依赖，不应将它们的代码、人设、用户目录或私人记忆打进包。
4. 运行下列检查，审阅打包清单，确认包含可直接加载的 `lib/`、patch、许可和文档，并排除凭证、测试数据及个人记忆：

```powershell
npm test
npm run check
npm pack --dry-run
npm pack
```

打包前脚本会运行代码检查。若版本未变更，默认产物为 `dsh-yangyu-0.2.0.tgz`。在干净、隔离的 profile 中安装该产物，验证侧栏、角色创建、记忆管理、持久绑定及与已安装插件共存，再配置测试模型账号验证真实回复和记忆工具调用。当前已验证的本机加载与原生会话流程，不替代这项真实模型验收。

验收还应包含边界输入：角色 JSON 导入最大 16 MiB，HTTP 请求体含包装最大 18 MiB；存储文件最大 16 MiB，人设最大 64,000 字符，单条记忆最大 8,000 字符。原 life 主会话误选到养鱼会话后，应能继续管理角色并新建对话；仅改回选择不足以清除可能已写入的历史通知。

官方 bundle、profile 与本地包安装说明见 [DSH 打包安装文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。

## 分发 tarball

可以先把检查过的 `.tgz` 上传到本人 GitHub 仓库的 Release，连同准确版本、更新记录和已知限制。用户可下载后安装：

```powershell
dsh plugin --profile desktop add "C:\path\to\dsh-yangyu-0.2.0.tgz"
```

安装后重启 DSH。本地源码链接安装需要保留源码目录，适合开发；提供独立 tarball 更方便用户长期使用。

## 发布 npm

完成名称、作者、仓库和模型验收后，使用本人 npm 发布账号登录，核对账号及目标 registry，再发布已经审阅的产物，例如：

```powershell
npm whoami
npm publish ./dsh-yangyu-0.2.0.tgz --access public
```

这是真实的公开发布动作，不属于打包检查。若名称或版本已改变，应替换命令中的文件名。发布成功后核对 registry 上的版本和内容，再在用户安装说明中加入对应 npm 安装命令；不要提前宣称用户已经可以从 npm 安装。

## 提交插件市场索引

目标社区索引为 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。它有自己的维护与审核流程；npm 发布不会自动使插件被该市场收录。提交前重新阅读目标仓库的[贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)，按当时要求操作。

2026-11-04 查阅到的指南要求：在索引仓库增加 `data/plugins/<owner>__<repo>.yml`，填写真实仓库 URL、名称、合适分类和英文功能描述；README 由索引生成，不应手动修改。仓库须有可用代码、已创建至少一天，并添加 `dsh-plugin` topic。下面仅是待替换的格式示例，**不是已提交条目**：

```yaml
url: https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY
name: YOUR_ACCOUNT/YOUR_REPOSITORY
category: identity
description:
  en: Multi-character companions with optional personas, separate memories, and persistent chat bindings.
  zh: 支持可选人设、独立记忆与持久会话绑定的多角色陪伴插件。
```

分类应按实际功能和提交时指南复核。若提供可选 `tarball`，应指向本人 GitHub Release 托管的真实 HTTPS `.tgz`；带版本文件名应使用固定 tag 的下载链接，避免新版发布后旧链接失效。不要上传插件用户的角色导出作为演示数据。提交后以维护者审核及实际收录结果为准，届时再更新本仓库发布状态。

## 后续更新

更新版本与 CHANGELOG，重新检查、打包、安装验收，再分别核对 GitHub、npm 和市场上的实际版本。客户端代码更新需要用户重启 DSH。升级前建议备份用户的 `storages/dsh-yangyu/state.json`；不要把安装目录当作角色数据目录，不要在升级过程中自动迁移原 life 的私人记忆。已知兼容边界见 [COMPATIBILITY.md](COMPATIBILITY.md)。
