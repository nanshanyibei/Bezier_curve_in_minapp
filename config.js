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

  // CloudBase 通用版（腾讯云控制台开通，tcb.cloud.tencent.com）
  // 免费体验版 3000 资源点/月。envId 在控制台「环境-概览」页复制，替换占位符后生效。
  // 未配置 / 未构建 npm 时，云端功能自动降级为纯本地模式。
  CLOUDBASE_ENV: 'eligible-gorilla-d4e0n4kdadfbdc4',

  // 云函数网关（HTTP 网关默认域名，已挂 /wxauth 路由）
  // 客户端不直连云函数（匿名身份被 EXCEED_AUTHORITY 拒绝），改走这个公网入口，
  // 鉴权由 wxauth 自己的 HMAC token 负责。上线前需在微信后台配 request 合法域名。
  CLOUD_GATEWAY_BASE: 'https://eligible-gorilla-d4e0n4kdadfbdc4-1311813133.ap-shanghai.app.tcloudbase.com',

  // 景点本地缓存有效期（毫秒，7 天）
  ATTRACTION_CACHE_TTL: 7 * 24 * 3600 * 1000
};
