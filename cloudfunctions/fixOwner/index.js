/**
 * 云函数 fixOwner：一次性数据修补 —— 给导入的文档补 _openid。
 *
 * 背景：控制台导入的文档属管理端写入，不带 _openid，"仅创建者可读写"权限下
 *       小程序端按身份查询返回空。服务端写入可显式设置 _openid，此函数批量补齐。
 *
 * 映射表：旧环境 owner openid → 新环境 openid。后续朋友数据认领时在 MAP 里加一行重传。
 *
 * 用法：部署后控制台「云端测试」直接运行（无需参数），返回 {marks: n, diaries: n, chats: n}。
 *       幂等，可重复执行。跑完确认后本函数可删除。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MAP = {
  'oQb-a5YTqlhDG5iqO-FZb8yjV160': 'o38w4xiZbcRiKNc_5wADi3Hx6KlM' // 南山
  // 'oQb-a5Rf2m27rcFrBoIfvZzKQbo4': '<朋友的新openid>' // 待其打开新小程序后补充
};

const COLS = ['marks', 'diaries', 'chats'];
const PAGE = 100;

exports.main = async () => {
  const res = {};
  for (const col of COLS) {
    let total = 0;
    for (const [oldOid, newOid] of Object.entries(MAP)) {
      let skip = 0;
      for (;;) {
        const r = await db.collection(col).where({ owner_old: oldOid }).skip(skip).limit(PAGE).get();
        const docs = r.data || [];
        for (const d of docs) {
          await db.collection(col).doc(d._id).update({ data: { _openid: newOid } });
          total++;
        }
        if (docs.length < PAGE) break;
        skip += PAGE;
      }
    }
    res[col] = total;
  }
  return { code: 0, updated: res };
};
