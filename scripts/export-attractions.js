/**
 * 导出种子数据为 CloudBase 控制台可导入的 JSON Lines 文件
 * 用法：node scripts/export-attractions.js
 * 产物：scripts/attractions-import.jsonl → 控制台「数据库 → attractions 集合 → 导入」
 * （集合需先创建；每行一个文档对象）
 */
const fs = require('fs');
const path = require('path');
const seed = require('../assets/data/attractions-seed');

const lines = seed.SEED.map((s) => JSON.stringify(Object.assign({ source: 'curated', createdAt: Date.now() }, s)));
const out = path.join(__dirname, 'attractions-import.jsonl');
fs.writeFileSync(out, lines.join('\n'), 'utf8');
console.log('OK ->', out, '(' + lines.length + ' 条)');
