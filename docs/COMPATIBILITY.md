# 0.2.0 与现有人设、生活及 QQ 桥共存

本文依据 2026-11-04 本机安装的 `dsh-persona-dafeiyu 0.7.3`、`dsh-dafeiyu-life 2.5.4`、原 `dsh-qq-bridge 0.1.0` 与本机 NapCat 接口整理。它说明已知兼容设计，不代表已对后续版本或真实平台往返完成验证。文档不包含账号、授权秘密、私人聊天或原记忆正文。

## 独立角色与原“小鱼”

养鱼为各角色建立独立身份、会话绑定与记忆存储，不把原 life 的“小鱼”身份库当成通用记忆服务。导入人设仅导入用户选择的人设文本；不会自动迁移、复制或合并原 life 的私人记忆。原插件与其生活数据继续由原插件管理。

life 目前只给明确指定的 `mainSessionId` 挂载人格与长期记忆，并向该会话发送生活同步、主动回忆、待办提醒等消息；没有“自动选最近会话”的回退。即使关闭长期记忆，该主会话仍可能挂载人格、成长与经历召回。因此，养鱼绑定时应拒绝原 life 主会话；运行中如果主会话配置变更造成冲突，应阻止该养鱼会话继续发言并提示解除冲突，不擅自改动原插件配置。新建养鱼专用会话是推荐用法。

## 配置来源与过滤项

life 数据目录优先由宿主 `ctx.get('dshHomePath')('bili-duty')` 决定，随后回退到 `$DSH_HOME/bili-duty/` 或用户目录下的 `.dsh/bili-duty/`。本机已确认默认位置为 `%USERPROFILE%\.dsh\bili-duty\config.json`，`mainSessionId` 是 JSON 顶层字符串字段。不要在日志中输出真实会话 ID 或其它配置值。

life 还合并宿主 `settings.describe()` 中 `dafeiyu-life` 行的设置。其本地 `_set`、非默认值及本地覆盖记录会影响优先级，仅读一个配置文件不一定能代表最终生效值。冲突检查应保守检查可取得的本地及宿主 `value`、`user` 中的主会话 ID；检查时沿用宿主会话 ID 的归一化方式。

养鱼会话的提示组装应过滤以下已知名称；普通会话保持原插件行为：

| 类型 | 名称 |
| --- | --- |
| persona sections | `dafeiyu:persona`、`dafeiyu:persona-suffix` |
| life sections | `dafeiyu-main-identity`、`dafeiyu-life-recall-hint`、`dafeiyu-memory-hint` |
| life contexts | `dafeiyu-memory`、`dafeiyu-owner-todos`、`dafeiyu-growth` |

life 的 `bili_*` 工具注册在根上下文，可能被其它会话继承。其中有读取原角色经历、写入其观看经历、修改配置或运行后台任务的工具。因此养鱼会话需要同时限制工具列表，并在执行入口阻止 `bili_*`、`dafeiyu_*` 工具；只隐藏按钮或只过滤提示词不足以隔离。原 life 主会话中的 `followup()` / `inject()` 会直接写入会话历史，不能靠提示组装过滤替代主会话冲突检查。

## 能力边界与更新复核

这里的记忆隔离是角色数据、提示组装与插件工具调用的应用层隔离，**不是操作系统沙箱**。宿主原生文件、终端等工具仍遵循宿主权限；用户主动要求读取某个文件时，这些工具可能读取插件记忆目录以外的文件。不要将角色隔离描述为任意文件或所有第三方插件之间的安全隔离。

0.2.0 的出游私聊另建受限的原生 DSH 会话，只开放本角色的 `yangyu_remember` 和 `yangyu_recall`，不继承 DSH 页面中用户主动开启的电脑工具权限。出游会话按平台、联系人区分，但同一角色的长期记忆仍共享；微信只接扫码本人，QQ 只接已配置允许名单。

原插件升级后，应重新核对配置来源、会话 ID 规则、提示名称、工具前缀及消息注入方式。新增名称或不同前缀可能超出本版已知过滤范围。至少复核：养鱼会话不出现原角色人设与记忆；原 life 主会话被拒绝绑定；运行时改成冲突主会话后停止生成；被禁工具不能执行；普通会话与原 life 仍照常工作。此清单是更新后的验证要求，不是已执行的测试报告。

## 原 QQ 桥与 NapCat

旧 `dsh-qq-bridge` 使用全局单账号和 `homeSessionId`，向原主会话投递，还可能读取原 life 人设、记忆及情绪。它不能直接替代养鱼按角色建立的出游会话。

旧桥与养鱼同时连接同一 OneBot 服务会重复消费消息。迁移应先备份旧桥配置，停用旧桥的 DSH 加载项与自动回复，再连接养鱼。旧 QQ 聊天、历史、life 记忆与人设可以保留；停用 QQ 桥不要求停用 life 或 persona。养鱼发现旧桥仍启用或重新启用时会拒绝连接或暂停聊天。

同平台的一个账号只可绑定一个养鱼角色，同一 NapCat WebUI 实例也只分配给一个角色。QQ 适配器检查 WebUI 返回账号及 OneBot 事件 `self_id`，发送前再次读取登录账号；实例换号后要求重新绑定，避免串发。多 QQ 并行需要独立实例，当前默认发现已有本机 NapCat。

服务未运行时，安全启动只执行已验证存在的 Boot 和配套文件，不调用旧终止 QQ 脚本，不下载组件，不关闭用户正在运行的 QQ。实例已登录时应显示现有账号，不能为了二维码擅自登出。

## 平台授权与角色导出

扫码挑战只在内存中保存；确认授权与出游会话映射存入独立的 `travel-private.json`，不进入角色 JSON 导出。删除角色会移除其本地出游连接；解除连接只停止本地收发并忘记授权，不执行平台远程登出。

微信使用官方 ClawBot / iLink 通道，协议参考 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)；QQ 对接 [NapCatQQ](https://github.com/NapNeko/NapCatQQ) 的本机接口。平台接口变化后，应重新验证二维码获取、刷新、本人确认、账号归属、收发范围和授权过期处理。扫码与手机验证码由用户本人完成，mock 测试不能替代真实账号验收。流程见 [TRAVEL.md](TRAVEL.md)。

源码依据：persona 的 `lib/index.js`；life 的 `lib/state.mjs`、`index.js`、`lib/long-term-memory.mjs`、`lib/main-session-bridge.mjs`；旧 QQ 桥的 `index.js`、`lib/onebot.mjs`；养鱼的 `travel-manager.js`、`travel-responder.js`、`travel-state.js` 与平台适配器。
