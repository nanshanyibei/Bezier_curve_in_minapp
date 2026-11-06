/**
 * 全局配置：AI 服务地址与模型（开发期小程序直连硅基流动）
 * 正式发布前需评估改为后端代理，避免 Key 暴露在客户端。
 */
module.exports = {
  // OpenAI 兼容 Base URL（硅基流动）
  LLM_BASE_URL: 'https://api.siliconflow.cn/v1',
  // 对话主模型（流式）
  CHAT_MODEL: 'deepseek-ai/DeepSeek-V3-0324',
  // 日记分析模型（非流式，JSON 输出）
  INSIGHT_MODEL: 'deepseek-ai/DeepSeek-V3-0324',
  // 单次请求超时（微信上限 60s）
  TIMEOUT: 60000,
  // 地理边界数据源（阿里 DataV GeoAtlas，静态行政边界，非瓦片服务）
  GEO_BASE: 'https://geo.datav.aliyun.com/areas_v3/bound/',
  // 边界文件本地缓存保留个数（LRU，存于 USER_DATA_PATH/geo/）
  GEO_CACHE_MAX: 8
};
