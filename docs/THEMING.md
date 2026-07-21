# SageRead 全局主题开发指南

SageRead 支持 Typora 式的全局主题：把一个 `.css` 文件放进主题文件夹，在设置里选中，整个应用界面就会换肤。本文面向主题作者，介绍主题机制、可用变量与语义钩子。

## 两层配色架构

SageRead 有两套互不影响的配色系统：

| 层 | 控制对象 | 配置方式 |
| --- | --- | --- |
| 应用 UI（本系统） | 书架、导航、侧边栏、AI 问答区、弹层、设置页 | 全局主题 `.css` 文件（本文档） |
| 书籍内部 | EPUB 正文、文字与背景色 | 阅读页设置里的"配色"palette（内置/自定义预设） |

全局主题的 CSS 只会注入应用主文档，**不会**注入书籍渲染的 iframe 内部；反过来阅读配色也不会影响应用界面。写主题时不用关心书籍内容。

## 快速上手

1. 找到用户主题文件夹（不存在会自动创建）：
   - Windows 正式版：`%APPDATA%\com.xincmm.sageread\themes`
   - Windows 开发版（identifier 带 `.dev` 后缀）：`%APPDATA%\com.xincmm.sageread.dev\themes`
   - 也可以直接点 设置 → 常规 → 外观 → 全局主题 旁边的「打开主题文件夹」按钮。
2. 把 `我的主题.css` 丢进该文件夹。
3. 点旁边的「刷新」按钮（不用重启），在下拉里选中它——用户主题会带"（自定义）"标注。
4. 选"默认"即可随时还原。

主题名 = 文件名（不含 `.css`）。用户主题与内置主题同名时，用户主题优先。应用启动时会自动应用上次选择的主题。

**显示名（`@name`）**：在 CSS 文件首行注释里声明中文名，设置下拉里就会显示它（缺省回退文件名），内置与用户主题都生效：

```css
/* @name 羊皮纸 */
```

注意必须位于文件最开头（允许前导空白），且只解析这一个注释。

## CSS 变量清单

应用组件的颜色基本都引用这组变量（定义见 `src/themes/default.css`），**覆盖变量是换肤的主手段**。在 `:root` 写浅色、在 `html.dark` 写深色：

| 变量 | 用途 |
| --- | --- |
| `--background` / `--foreground` | 全局背景 / 主文字色 |
| `--card` / `--card-foreground` | 卡片容器背景 / 文字 |
| `--popover` / `--popover-foreground` | 弹层（对话框、下拉、浮窗）背景 / 文字 |
| `--primary` / `--primary-foreground` | 主强调色（按钮、选中态）/ 其上文字 |
| `--secondary` / `--secondary-foreground` | 次要表面（弱按钮、标签） |
| `--muted` / `--muted-foreground` | 弱背景分层 / 辅助说明文字 |
| `--accent` / `--accent-foreground` | 悬停高亮、轻强调（如气泡底） |
| `--destructive` | 危险操作（删除等） |
| `--border` / `--input` / `--ring` | 边框 / 输入框边框 / 聚焦环 |
| `--sidebar` 系列（`-foreground` `-primary` `-accent` `-border` `-ring`） | 侧边栏专用配色 |
| `--font-sans` / `--font-serif` / `--font-mono` | 界面字体族 |
| `--radius` | 基础圆角 |

最小主题只需要覆盖少量变量，例如只换强调色：

```css
:root {
  --primary: #2f6f4f;
  --ring: #2f6f4f;
}
```

## data-region 语义钩子

变量覆盖不到的区域（比如组件里写死了 Tailwind 颜色类），用稳定语义钩子定位，不用逆向 DevTools 翻 DOM：

| 钩子 | 对应区域 |
| --- | --- |
| `app-sidebar` | 应用左侧导航栏（搜索、标签、入口） |
| `app-main` | 主内容区容器（书架/统计/聊天页路由出口） |
| `bookshelf` | 书架滚动区（网格与列表两种视图共用） |
| `book-card` | 单本书籍卡片 |
| `book-cover` | 书籍封面容器（内部为 `img` 或占位块） |
| `reader-tabs` | 阅读页顶部书籍标签条 |
| `notepad-panel` | 阅读页笔记侧边栏容器 |
| `chat-panel` | AI 问答面板整体（阅读页右侧 / 聊天页） |
| `chat-message-user` | 单条用户消息（气泡本体为内部 `.prose` 元素） |
| `chat-message-assistant` | 单条 AI 消息（同上） |
| `dialog` | 所有对话框弹层（shadcn Dialog 共用挂载点） |
| `settings-panel` | 设置弹窗主体（左侧导航 + 右侧内容） |

选择器写法：`[data-region="book-card"] { ... }`。钩子的稳定性受版本维护承诺约束，优先于猜测 Tailwind 类名。

## 常用片段示例

### 换强调色

```css
:root {
  --primary: #a05a2c;
  --ring: #a05a2c;
  --sidebar-primary: #a05a2c;
}
```

### 给书架加纸张纹理（内联 SVG，无外部资源）

```css
html:not(.dark) [data-region="bookshelf"] {
  background-color: var(--background);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='matrix' values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.05 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
```

注意纹理要叠加到**可见容器**上：写到 `body` 会被根布局不透明的背景色完全盖住。

### 封面边框 + 卡片悬停

```css
[data-region="book-cover"] {
  border: 1px solid var(--border);
  border-radius: 6px;
}

[data-region="book-card"] {
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
[data-region="book-card"]:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.15);
}
```

### 问答区用户气泡

```css
[data-region="chat-message-user"] .prose {
  background-color: var(--accent);
  color: var(--accent-foreground);
}
```

### 全局字体

```css
:root {
  --font-sans: "LXGW WenKai", "PingFang SC", sans-serif;
}
```

字体名必须是系统已安装字体。设置里的"字体管理"上传的字体（`.woff2`，存于应用数据目录 `fonts/`）是供**书籍正文**使用的，不会自动注册为界面字体；想让界面也用某个字体文件，可在主题里用 `@font-face` 自行声明（路径需为可访问的绝对路径，一般不推荐，优先用系统字体）。

## 注意事项

- **深色模式**：应用用 `<html class="dark">` 切换。主题若不写 `html.dark` 块，深色模式回落默认主题的深色变量；写了就能完全掌控两套配色。区域性规则里引用 `var(--xxx)` 而不是写死颜色，可让一条规则自动适配深浅两套。
- **硬编码颜色类**：部分组件写死了 Tailwind 颜色（如 `bg-white`、`text-neutral-600`、`dark:bg-neutral-800`），覆盖变量对这些元素无效，需要用 data-region 钩子写更具体的选择器直接指定（特异性高于单个工具类即可，通常不需要 `!important`）。
- **注入顺序**：主题 CSS 注入在 `document.head` 末尾的 `<style id="sageread-global-theme">`，在打包样式之后，同特异性下主题规则优先。
- **书籍 iframe 不受影响**：`data-region` 钩子都在应用文档里；任何全局主题规则都不会渗进书籍渲染 iframe，反之亦然。
- **参考模板**：内置主题 `parchment`（`public/themes/parchment.css`）就是按本文档写的教学模板，分区注释齐全，可直接复制改名后修改。
