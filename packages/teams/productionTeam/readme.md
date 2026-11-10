# productionTeam

影视制作流水线团队包。每个制作大阶段对应一名成员，成员只在房间工作区的 `production/` 目录内读写版本化产物，交付以文件为准。

当前成员：

- `scriptwriter`（入口）——文学剧本阶段：读取 `production/draft.md`、`production/brief.json`（修订轮还有 `production/reviews/` 与上一版剧本），写出 `production/script/v{round}.md` 与 `v{round}.json`，最终回复只输出 JSON 改编说明报告 `{summary, changes}`。

私有技能 `scriptwriting` 提供结构、对白与修订方法；由房间编排器（customer_service）通过 `subAgent` 工具按轮次委派，编排器负责校验产物、投递到房间并主持用户审阅。
