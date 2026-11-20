# 我的衣橱（公开小程序）

这是一份可在手机和电脑上直接打开的静态衣橱小程序：查看已整理的单品、按场合和你填写的气温生成搭配，并标明哪些主图只是同款参考。

衣橱内容在 [`data.json`](./data.json)，搭配和筛选规则在 [`logic.js`](./logic.js)，页面在 [`app.js`](./app.js)。商品图放在 [`images/`](./images/) 目录，不使用外链。改公开清单要改 JSON 再提交；浏览器里的本机修改和导入只留在那台设备，不会自动写回仓库。

- 页面更新：2026-11-20
- 清单核对：2026-11-12
- 仓库：https://github.com/Itachi0819-a/wardrobe
- 在线使用（GitHub Pages）：https://itachi0819-a.github.io/wardrobe/
- 原始数据（给 AI 直接读取）：https://raw.githubusercontent.com/Itachi0819-a/wardrobe/main/data.json

本页不含个人照片、姓名、电话、地址、身高体重、服装或鞋的尺码、订单号，也不含病情相关信息。

## 怎么用

打开上面的 Pages 链接，可以：

- 按分类、状态、来源平台或关键词筛选单品
- 查看每件的品牌、颜色、状态、主图来源，以及是否为同款参考
- 选择场合；气温留空就不会假设今天冷热，也不会自动加外套
- 生成一套主要搭配，并在有不同上衣时给一套备选。这是筛选建议，不是试穿结果
- 展开「已淘汰/不常穿」分组（可恢复，但不参与搭配）
- 在「本机」里导出、预览后合并导入，或在确认后清除本机修改。导入不会因为文件里少了某件就删掉它

本页不能生成上身图，也没有模拟试穿。不要把本人照片传进这个公开仓库。

本地预览：`python3 -m http.server 8080`，然后打开 `http://localhost:8080`。不要直接用 `file://` 打开，浏览器可能拦截 `data.json`。

检查：`node --check logic.js && node --check app.js`，测试：`node --test`。没有单独的构建步骤，也没有第三方依赖。

## 别人或其他 AI 怎么改

仓库是公开的，谁都可以读取。GitHub 不会让路人直接改主分支，所以「谁都能修改」的实际做法是：

1. **Fork** 本仓库，改 `data.json`（或页面文件、图片），再开 **Pull Request**。仓库主人审核后合并，Pages 会自动更新。
2. 仓库主人自己改：在 GitHub 网页打开 `data.json`，点编辑，改完提交到 `main`。
3. 把 [raw data.json](https://raw.githubusercontent.com/Itachi0819-a/wardrobe/main/data.json) 和 [AI_INSTRUCTIONS.md](./AI_INSTRUCTIONS.md) 发给 ChatGPT、Gemini、Claude 等，它们可以按说明起草修改，再通过 PR 或由主人提交。

请不要把协作者权限随便加给陌生人。

## 必须遵守的整理规则

- 搭配只使用确认仍保留、可穿的单品
- 不穿乐福鞋；不太喜欢深咖色，但不排斥所有棕色或卡其
- 退货、取消或状态不明的不算衣橱
- 外观相似不能当同款；主图若是同款参考或同款候选，必须标明
- 已购·仅记录（内裤、袜子、拖鞋、工作鞋、泳装、保暖内衣、护目镜等）和已淘汰/不常穿的单品不进入搭配
- 不要把个人照片、尺码、身高体重或订单号写进本仓库

更完整的数据结构和修改说明见 [AI_INSTRUCTIONS.md](./AI_INSTRUCTIONS.md)。
