# 文字净化（SillyTavern 扩展）

一个轻量的 SillyTavern 确定性文本替换扩展。仅执行用户配置的规则，不包含 AI 改写、模型调用或 API 配置。

## 功能

- 规则合集与子规则分组管理，可分别启用、停用、编辑和删除。
- 普通文本匹配：逐行填写多个目标词句。
- 简易通配：支持 `*`（匹配一小段非标点文本）和 `{A,B,C}`（多个候选写法）。
- 正则表达式：支持捕获组替换，如 `$1`、`$2`。
- 每条子规则可配置多个替换候选，命中时随机选择；替换内容留空表示删除。
- 默认只处理 `<content>...</content>` 正文范围，避免误改状态栏和其他美化文本；也可自定义标签范围，留空则处理全部普通文本节点。
- 自动处理新收到的助手消息，支持手动净化最新楼层。
- 规则合集支持 JSON 导入和导出。
- 保留旧版扁平规则设置，首次启动时自动迁移到「已迁移规则」合集。

## 安装

在 SillyTavern「扩展」→「安装扩展」中粘贴：

`https://github.com/1614130601zjs-del/no`

Termux 安装或更新：

```bash
cd ~/SillyTavern/data/default-user/extensions && if [ -d st-text-replacer/.git ]; then cd st-text-replacer && git pull --ff-only; else git clone https://github.com/1614130601zjs-del/no.git st-text-replacer; fi
```

安装后刷新酒馆页面，在扩展设置中找到「文字净化」。

## 作用范围

默认只处理 `<content>...</content>` 内的普通文本节点，不会改写标签、属性、HTML 注释以及 `script`、`style`、`textarea`、`pre`、`code` 内部内容。

可在「只处理指定标签内的正文」修改标签名，例如 `content`；多个标签名可用空格或逗号分隔。留空会处理全部普通文本节点。标签范围按消息 HTML 结构判断，不会处理容器外的状态栏文字。

## 规则格式

- 普通文本和简易通配：每行一条匹配目标。
- 正则：每行一条正则；也可写成 `/pattern/flags`。
- 替换候选：每行一条，命中时随机选取；不填写则直接删除。
- 正则替换模板支持 `$1`、`$2` 等捕获组。

规则保存在 SillyTavern 扩展设置中，不会发送到外部服务。
