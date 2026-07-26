# 📄 X Articles Formatting & Publishing Guide

> **Reference Manual for Publishing Technical Articles on X (Twitter)**

---

## 📌 Core Platform Mechanics

1. **Rich-Text Composer (Draft.js)**:
   - X Articles use a rich-text WYSIWYG editor (Draft.js) rather than a raw Markdown parser.
   - Standard text features (Heading 1 `#`, Heading 2 `##`, Bold `**`, Bullet Lists `-`, Blockquotes `>`) convert automatically when pasting rich text.

2. **Diagrams & Flowcharts**:
   - **Important**: X Articles do **NOT** render raw ```mermaid code blocks or ASCII box characters (`┌`, `─`, `│`, `└`). Monospace text boxes may wrap or distort on mobile viewports.
   - **Best Practice**: Render all diagrams, flowcharts, and architecture maps as high-resolution PNG or WebP images and insert them directly into the article body via X's image attachment tool.

3. **Code Snippets & Configurations**:
   - Inline code snippets and small blocks work in monospace text mode.
   - For long code blocks or complex config files, use crisp screenshot graphics (e.g. generated via Carbon or high-res terminal captures) to maximize readability and engagement.

4. **Image Specifications**:
   - **Header Image**: Recommended ratio `16:9` (e.g., `1200 x 675` or `1920 x 1080`). Use text-free futuristic artwork to avoid weird cropping issues.
   - **Diagram Images**: High-resolution PNGs with high contrast and legible typography (minimum 16px font equivalent).

---

## 🚀 Step-by-Step Publishing Workflow for `cloud_integration_post.md`

1. Open **X.com** on desktop $\rightarrow$ Click **Articles** in the left navigation sidebar.
2. Set **Header Image**: Upload `/home/krusch/Pictures/cloud_database_header.png`.
3. Set **Title**: `Going 100% Cloud-Native: Infinite Agent Working Memory with krusch-context-mcp, Polygres.com & OpenRouter`
4. Copy the article body from [`docs/cloud_integration_post.md`](file:///home/krusch/homelab/projects/krusch-context-mcp/docs/cloud_integration_post.md).
5. In the **Architecture** section, click the **+** (Add Media) icon and upload `/home/krusch/Pictures/cloud_architecture_diagram.png`.
6. Preview on Desktop and Mobile viewports $\rightarrow$ Click **Publish**.
