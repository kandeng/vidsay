# 交付格式（envelope）

每轮交付两个文件到 `production/script/`，N 为轮次号：

## vN.md（给人读）

Markdown 文学剧本全文，结构：

```markdown
# 《片名》

一句话故事（logline）。

## 1. 内. 老屋厨房 - 夜

场景叙述……

**角色名**：台词……

## 2. 外. 巷口 - 夜
……
```

## vN.json（给下游阶段消费）

严格符合以下结构，字段不能增删改名；服务器会用同一模式校验，不合格会被退回：

```json
{
  "version": 1,
  "title": "片名（1–200 字）",
  "logline": "一句话故事（1–1000 字）",
  "language": "zh（可省略；跟随 brief 或草稿语言）",
  "estimatedMinutes": 3,
  "scenes": [
    {
      "id": "s1",
      "heading": "内. 老屋厨房 - 夜",
      "summary": "本场景剧情叙述（1–4000 字）",
      "beats": ["节拍一：可见动作或转折", "节拍二"],
      "dialogue": [{ "role": "角色名", "line": "台词原文" }]
    }
  ]
}
```

约束：`version` 为正整数且等于 N；`scenes` 1–100 个；scene `id` 形如 s1、s2 且全片唯一递增；`beats` 每条 1–500 字、每场景至多 50 条；`dialogue` 每场景至多 200 条，role 1–80 字、line 1–2000 字；`estimatedMinutes` 为正数（可省略）。

JSON 合法性硬性要求：vN.json 必须能被 `JSON.parse` 直接解析。字符串内部的引号一律使用中文引号“”或「」，不得出现未转义的英文双引号 `"`；字符串内换行用 `\n` 转义。写完 vN.json 后必须用 read 读回自检一遍，确认引号已转义、括号逗号完整，再结束本轮。

两个文件内容必须一致：md 里的场景、叙述与对白和 json 一一对应，json 是 md 的忠实结构化，不是另一版创作。
