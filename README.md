<div align="center">
<img src="https://raw.githubusercontent.com/cooderl/wewe-rss/main/assets/logo.png" width="80" alt="预览"/>

# we2rss

一种将微信公众号文章转为rss的工具，基于wewe-rss项目。

![主界面](https://raw.githubusercontent.com/cooderl/wewe-rss/main/assets/preview1.png)
</div>

## ✨ 功能


- 支持微信公众号订阅（基于微信读书）
- 获取公众号历史发布文章
- 后台自动检查账号有效性，失效后自动通知到钉钉、飞书、企业微信等webhook，重新扫码后自动更新账号状态
- 后台自动定时更新内容
- 微信公众号RSS生成（支持`.atom`、`.rss`、`.json`格式)

### 高级功能

- **标题过滤**：支持通过`/feeds/all.(json|rss|atom)`接口和`/feeds/:feed`对标题进行过滤
  ```
  {{ORIGIN_URL}}/feeds/all.atom?title_include=张三
  {{ORIGIN_URL}}/feeds/MP_WXS_123.json?limit=30&title_include=张三|李四|王五&title_exclude=张三丰|赵六
  ```

- **手动更新**：支持通过`/feeds/:feed`接口触发单个feedid更新
  ```
  {{ORIGIN_URL}}/feeds/MP_WXS_123.rss?update=true
  ```

## 🚀 部署

开源版 Cloudflare 一键部署：`docs/open-source-deploy.md`

## 👨‍💻 感谢大佬

<a href="https://github.com/cooderl/wewe-rss/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=cooderl/wewe-rss" />
</a>

## 📄 License

[MIT]
