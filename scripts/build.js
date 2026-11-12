/*
 * 生产包构建脚本
 *
 * 用法：
 *   node scripts/build.js prod     # 生成 dist/prod（无 AI 能力，用于提审上线）
 *   node scripts/build.js dev      # 仅打印当前开发包说明，不做任何事
 *
 * 做了什么：
 *   1. 按白名单拷贝源码到 dist/prod
 *   2. 剔除 AI 相关页面与工具模块
 *   3. 剥离所有 @dev:begin / @dev:end 标记块
 *   4. 重写 app.json 的 pages 列表
 *   5. 生成 dist/prod/project.config.json
 *   6. 残留关键词校验，命中即构建失败
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'prod');

/** 顶层拷贝白名单 */
const TOP_ENTRIES = ['app.js', 'app.json', 'app.wxss', 'config.js', 'sitemap.json', 'pages', 'utils', 'assets'];

/** 生产包剔除的页面目录（相对 pages/） */
const DROP_PAGES = ['assistant', 'insight', 'index', 'share'];

/** 生产包剔除的工具模块（相对 utils/） */
const DROP_UTILS = ['ai.js', 'sse.js', 'insightPrompt.js', 'insightParse.js'];

/** 生产包页面清单，顺序即注册顺序 */
const PROD_PAGES = [
  'pages/diary/diary',
  'pages/travel/travel',
  'pages/travel/list/list',
  'pages/my/my',
  'pages/my/privacy/privacy'
];

/** 文本文件后缀（参与标记剥离与关键词校验） */
const TEXT_EXT = ['.js', '.json', '.wxml', '.wxss'];

/** 残留关键词，命中即失败 */
const FORBIDDEN = [
  { re: /@dev:begin|@dev:end/, label: '未剥离的 dev 标记' },
  { re: /siliconflow|deepseek/i, label: '模型服务商' },
  { re: /\bAI\b/, label: 'AI 字样' },
  { re: /人工智能|深度合成|换脸|AI 绘画|AI问答|AI 问答/, label: '深度合成类表述' },
  { re: /pages\/assistant|pages\/insight/, label: 'AI 页面路由' },
  { re: /\b(LLM_BASE_URL|CHAT_MODEL|INSIGHT_MODEL)\b/, label: '模型配置项' }
];

function log(msg) {
  console.log(msg);
}

function rimraf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function copyDir(src, dest, filter) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (filter && !filter(name)) continue;
    const s = path.join(src, name);
    const d = path.join(dest, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** 剥离 @dev 标记块：先 HTML 注释，再 JS 块注释 */
function stripDevBlocks(code) {
  const html = /[ \t]*<!--[ \t]*@dev:begin[ \t]*-->[\s\S]*?<!--[ \t]*@dev:end[ \t]*-->[ \t]*\r?\n?/g;
  const js = /[ \t]*\/\*[ \t]*@dev:begin[ \t]*\*\/[\s\S]*?\/\*[ \t]*@dev:end[ \t]*\*\/[ \t]*\r?\n?/g;
  return code.replace(html, '').replace(js, '');
}

function walk(dir, hit) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, hit);
    else hit(p);
  }
}

function buildProd() {
  log('→ 清理输出目录');
  rimraf(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  log('→ 拷贝源码');
  for (const entry of TOP_ENTRIES) {
    const src = path.join(ROOT, entry);
    if (!fs.existsSync(src)) {
      log('  跳过（不存在）：' + entry);
      continue;
    }
    const st = fs.statSync(src);
    if (!st.isDirectory()) {
      fs.copyFileSync(src, path.join(OUT, entry));
      continue;
    }
    const filter = entry === 'pages'
      ? (name) => !DROP_PAGES.includes(name)
      : entry === 'utils'
        ? (name) => !DROP_UTILS.includes(name)
        : null;
    copyDir(src, path.join(OUT, entry), filter);
  }

  log('→ 剥离 @dev 标记块');
  let stripped = 0;
  walk(OUT, (file) => {
    if (!TEXT_EXT.includes(path.extname(file))) return;
    const before = fs.readFileSync(file, 'utf8');
    const after = stripDevBlocks(before);
    if (after !== before) {
      fs.writeFileSync(file, after, 'utf8');
      stripped++;
    }
  });
  log('  已处理 ' + stripped + ' 个文件');

  log('→ 重写 app.json');
  const appJsonPath = path.join(OUT, 'app.json');
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  appJson.pages = PROD_PAGES.slice();
  fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + '\n', 'utf8');

  log('→ 生成 project.config.json');
  const devCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'));
  const prodCfg = Object.assign({}, devCfg, {
    description: '生产包（纯本地工具，无 AI 能力）',
    projectname: 'Bezier_curve_in_minapp_PROD',
    miniprogramRoot: './',
    condition: { miniprogram: { list: [] } }
  });
  fs.writeFileSync(path.join(OUT, 'project.config.json'), JSON.stringify(prodCfg, null, 2) + '\n', 'utf8');

  log('→ 校验');
  const errors = [];

  // 页面文件完整性
  const needExt = ['.js', '.json', '.wxml', '.wxss'];
  for (const page of PROD_PAGES) {
    for (const ext of needExt) {
      const f = path.join(OUT, page + ext);
      if (!fs.existsSync(f)) errors.push('缺文件：' + page + ext);
    }
  }

  // 关键词残留
  walk(OUT, (file) => {
    if (!TEXT_EXT.includes(path.extname(file))) return;
    if (path.basename(file) === 'project.config.json') return;
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(OUT, file).replace(/\\/g, '/');
    for (const rule of FORBIDDEN) {
      const m = text.match(rule.re);
      if (m) {
        const line = text.slice(0, m.index).split('\n').length;
        errors.push(rel + ':' + line + ' 命中「' + rule.label + '」→ ' + m[0]);
      }
    }
  });

  if (errors.length) {
    log('');
    log('✗ 构建失败，发现问题 ' + errors.length + ' 处：');
    errors.forEach((e) => log('  - ' + e));
    process.exit(1);
  }

  const size = (() => {
    let total = 0;
    walk(OUT, (f) => { total += fs.statSync(f).size; });
    return (total / 1024).toFixed(1);
  })();

  log('');
  log('✓ 生产包已生成：' + path.relative(ROOT, OUT).replace(/\\/g, '/'));
  log('  页面：' + PROD_PAGES.length + ' 个 · 体积：' + size + ' KB');
  log('  下一步：微信开发者工具 → 导入项目 → 选择 dist/prod 目录 → 上传');
}

function main() {
  const mode = process.argv[2] || 'prod';
  if (mode !== 'prod') {
    log('当前模式：dev（根目录即开发包，含全部能力，直接在开发者工具打开根目录即可）');
    log('生成生产包：node scripts/build.js prod');
    return;
  }
  buildProd();
}

main();
