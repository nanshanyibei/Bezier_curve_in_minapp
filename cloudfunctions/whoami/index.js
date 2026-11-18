/**
 * 云函数 whoami：返回调用者 openid。
 * 用途：客户端登录态确认 + 数据认领（旧环境 owner → 新环境 _openid 映射）。
 * 无状态、无数据库操作，每次调用消耗极低。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async () => {
  const ctx = cloud.getWXContext();
  return { openid: ctx.OPENID || '', appid: ctx.APPID || '' };
};
