# CloudBase 数据备份（2026-11-17）

来源环境：`eligible-gorilla-d4e0n4kdadfbdc4`（腾讯云 CloudBase 体验版，包月周期 11-09~12-09，预计 11-19 前后点数耗尽停服）
导出方式：CloudBase MCP 管理端逐集合全量拉取，导出后已校验条数一致。

## 内容清单

| 文件 | 集合 | 条数 | 说明 |
|---|---|---|---|
| marks.json | marks | 109 | 足迹标记，_id = `{owner}_{adcode}`，pgdoc 嵌套结构 `{_id, data}` |
| diaries.json | diaries | 2 | 日记，_id = `{owner}_{date}` |
| chats.json | chats | 2 | AI 聊天历史，_id = `{owner}_history` |
| attractions.json | attractions | 34 | 景点预置数据（全部 source=curated，扁平结构） |

合计 147 条，约 38KB。

## 云存储

云端未发现任何已上传文件：COS 本周期用量为 0，且 marks/diaries/chats 中无 fileID 字段、attractions 的 img 全为空字符串。**无需搬迁图片**，迁移评估文档里的"图片搬迁风险"可以划掉。

## 迁移要点（备忘）

1. marks/diaries/chats 是 pgdoc 嵌套结构，attractions 是扁平结构——导入新环境时统一处理。
2. `data.owner` 字段在新环境需映射为 `_openid`（openid 同 appid 下不变，用户数据可自动认回）；也可保留 `owner` 字段由服务端按旧逻辑鉴权。
3. `_id` 已含 owner 前缀，直接按原 _id 导入即可保持幂等（put 覆盖语义不变）。
4. 云函数代码在本地 `cloudfunctions/`（wxauth、genAttraction）；wxauth 的环境变量（WX_APPID/WX_SECRET/HMAC 盐）只存在云端配置里，值未导出，重建时需在云开发控制台重新配置。
