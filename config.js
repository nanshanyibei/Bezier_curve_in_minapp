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
  // 对话主模型（流式）
  CHAT_MODEL: 'deepseek-ai/DeepSeek-V3-0324',
  // 日记分析模型（非流式，JSON 输出）
  INSIGHT_MODEL: 'deepseek-ai/DeepSeek-V3-0324',
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
  CLOUDBASE_ENV: 'eligible-gorilla-d4e0n4kdadfbdc4d',

  // 景点本地缓存有效期（毫秒，7 天）
  ATTRACTION_CACHE_TTL: 7 * 24 * 3600 * 1000
};
