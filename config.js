/* @dev:begin */
/**
 * 全局配置：AI 服务地址与模型（开发期小程序直连硅基流动）
 * 仅本地开发版本使用，生产构建会整段剥离。
 * 正式发布前需改为后端代理，避免 Key 暴露在客户端。
 */
/* @dev:end */
module.exports = {
  /* @dev:begin */
  // OpenAI 兼容 Base URL（硅基流动）
  LLM_BASE_URL: 'https://api.siliconflow.cn/v1',
  // 对话主模型（流式）。选型 2026-11-12：DeepSeek-V4-Flash（¥1.5/¥4.5 每百万 token，1M 上下文）
  // 备选：Qwen/Qwen3.5-35B-A3B（¥0.4/¥3.2 最便宜档）、DeepSeek-V3.2（¥4/¥6 质量优先）
  CHAT_MODEL: 'deepseek-ai/DeepSeek-V4-Flash',
  // 日记分析模型（非流式，JSON 输出）
  INSIGHT_MODEL: 'deepseek-ai/DeepSeek-V4-Flash',
  // 单次请求超时（微信上限 60s）
  TIMEOUT: 60000,
  /* @dev:end */

  // 地理边界数据源：geojson.cn（京ICP备16004892号-4，阿里云 OSS/CDN）
  // 注意：阿里 DataV geo.datav.aliyun.com 有 Referer 防盗链，带 servicewechat.com 的请求一律 403，
  // 小程序无法自定义 Referer，故不可用。此源实测不校验 Referer。
  GEO_BASE: 'https://file.geojson.cn/china/1.6.3/',
  // 边界文件本地缓存保留个数（LRU，存于 USER_DATA_PATH/geo/）
  GEO_CACHE_MAX: 8,

  // 微信云开发环境（2026-11 迁移，旧腾讯云 CloudBase 环境废弃，见 docs/migrate-to-wxcloud.md）
  // 环境在 mp.weixin.qq.com「云服务-云开发」创建，wx.cloud 直连，免域名免备案。
  // 未配置时云端功能自动降级为纯本地模式。
  WX_CLOUD_ENV: 'ai-walk-d6g6stcxs36a8e427',

  // 景点生成类请求超时（模型生成 15~30s，微信 wx.request 上限 60s）
  GEN_TIMEOUT: 55000,

  // 景点本地缓存有效期（毫秒，7 天）
  ATTRACTION_CACHE_TTL: 7 * 24 * 3600 * 1000
};
