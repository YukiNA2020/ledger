/* 小账本 server/login-item.js — macOS 登录启动项管理（Phase 2）
 *
 * 依据 ARCHITECTURE §7.1 / DECISIONS T-005：
 *   - 采用 LaunchAgent（仅本机、可卸载、失败可见、不会重复启动多个写入进程）；
 *   - 登录后自动启动本地服务并由服务打开产品页；
 *   - 失败写日志到 <数据目录>/logs/，可由用户在"登录项/LaunchAgents"里禁用或卸载。
 *
 * 重要：本模块只负责生成/安装/卸载启动项文件。安装动作会调用 launchctl，属于系统级操作。
 *      默认 install 只写文件并打印需要用户执行的命令；只有显式 --activate 才会调用 launchctl。
 *
 * CLI：
 *   node server/login-item.js print                      打印 plist 内容
 *   node server/login-item.js install  [--activate]       写 plist（可选立即加载）
 *   node server/login-item.js uninstall [--activate]      删除 plist（可选先卸载）
 *   node server/login-item.js status                      查询当前状态
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LABEL = 'com.ledger.local';
const NODE_CANDIDATES = [
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  '/opt/homebrew/opt/node/bin/node',
  '/usr/bin/node'
];

function launchAgentsDir() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

function plistPath() {
  return path.join(launchAgentsDir(), LABEL + '.plist');
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function supportsSqlite(nodePath) {
  try {
    execFileSync(nodePath, ['-e', "require('node:sqlite')"], { stdio: 'ignore', timeout: 8000 });
    return true;
  } catch (_) {
    return false;
  }
}

// 选择自带 node:sqlite 的 Node 运行时；显式路径优先
function resolveNode(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error('指定的 Node 路径不存在：' + explicit);
    if (!supportsSqlite(explicit)) throw new Error('指定的 Node 不支持 node:sqlite：' + explicit);
    return explicit;
  }
  const candidates = NODE_CANDIDATES.concat([process.execPath]);
  const seen = {};
  for (const candidate of candidates) {
    if (seen[candidate]) continue;
    seen[candidate] = true;
    if (!fs.existsSync(candidate)) continue;
    if (supportsSqlite(candidate)) return candidate;
  }
  throw new Error('未找到支持 node:sqlite 的 Node 运行时（可用 --node 指定路径）');
}

function renderPlist(options) {
  const o = options || {};
  const args = [
    o.nodePath,
    o.scriptPath,
    '--data-dir',
    o.dataDir,
    '--port',
    String(o.port)
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>' + xmlEscape(LABEL) + '</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((a) => '    <string>' + xmlEscape(a) + '</string>'),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    '  <string>' + xmlEscape(path.dirname(o.scriptPath)) + '</string>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ProcessType</key>',
    '  <string>Interactive</string>',
    '  <key>StandardOutPath</key>',
    '  <string>' + xmlEscape(path.join(o.logDir, 'launchd.out.log')) + '</string>',
    '  <key>StandardErrorPath</key>',
    '  <string>' + xmlEscape(path.join(o.logDir, 'launchd.err.log')) + '</string>',
    '</dict>',
    '</plist>',
    ''
  ].join('\n');
}

// 用 plutil 校验 plist 合法性（不写入用户 LaunchAgents 目录）
function lintPlist(plistText) {
  const tmp = path.join(os.tmpdir(), 'ledger-plist-lint-' + process.pid + '.plist');
  try {
    fs.writeFileSync(tmp, plistText, { mode: 0o600 });
    execFileSync('/usr/bin/plutil', ['-lint', tmp], { stdio: 'ignore', timeout: 8000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err && err.message) || 'plutil 校验失败' };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* 临时文件清理失败不影响结论 */
    }
  }
}

function domainTarget() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return uid == null ? null : 'gui/' + uid;
}

function launchctl(args) {
  try {
    const out = execFileSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 15000 });
    return { ok: true, out: out || '' };
  } catch (err) {
    return { ok: false, out: (err && err.stdout) || '', err: (err && err.stderr) || (err && err.message) || '' };
  }
}

function buildDefaultOptions(options) {
  const o = options || {};
  const dataDir = o.dataDir || require('./config').resolveDataDir();
  return {
    nodePath: resolveNode(o.nodePath),
    scriptPath: path.join(require('./config').REPO_ROOT, 'server', 'main.js'),
    dataDir: dataDir,
    port: o.port || require('./config').resolvePort(),
    logDir: path.join(dataDir, 'logs')
  };
}

function install(options) {
  const o = options || {};
  const resolved = buildDefaultOptions(o);
  const text = renderPlist(resolved);
  const lint = lintPlist(text);
  if (!lint.ok) throw new Error('生成的 plist 未通过校验：' + lint.reason);

  fs.mkdirSync(launchAgentsDir(), { recursive: true });
  fs.mkdirSync(resolved.logDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(plistPath(), text, { mode: 0o644 });

  const result = { plistFile: plistPath(), options: resolved, activated: false };
  if (o.activate) {
    const target = domainTarget();
    launchctl(['bootout', target, plistPath()]); // 已加载时先卸载，失败可忽略
    const loaded = launchctl(['bootstrap', target, plistPath()]);
    result.activated = loaded.ok;
    result.activateError = loaded.ok ? null : loaded.err;
  }
  return result;
}

function uninstall(options) {
  const o = options || {};
  const file = plistPath();
  const target = domainTarget();
  let deactivated = null;
  if (o.activate && fs.existsSync(file)) {
    const unloaded = launchctl(['bootout', target, file]);
    deactivated = unloaded.ok;
  }
  const existed = fs.existsSync(file);
  if (existed) fs.unlinkSync(file);
  return { plistFile: file, removed: existed, deactivated: deactivated };
}

function status() {
  const file = plistPath();
  const target = domainTarget();
  const loaded = launchctl(['print', target + '/' + LABEL]);
  return {
    label: LABEL,
    plistFile: file,
    installed: fs.existsSync(file),
    loaded: loaded.ok,
    detail: loaded.ok ? '已加载' : (loaded.err || '').trim().split('\n')[0] || '未加载'
  };
}

function cli(argv) {
  const action = argv[0] || 'status';
  const activate = argv.indexOf('--activate') !== -1;
  const nodeArgIndex = argv.indexOf('--node');
  const nodePath = nodeArgIndex !== -1 ? argv[nodeArgIndex + 1] : null;

  if (action === 'print') {
    process.stdout.write(renderPlist(buildDefaultOptions({ nodePath: nodePath })) + '\n');
    return 0;
  }
  if (action === 'install') {
    const result = install({ activate: activate, nodePath: nodePath });
    process.stdout.write(
      [
        '已写入登录启动项：' + result.plistFile,
        '  Node：' + result.options.nodePath,
        '  数据目录：' + result.options.dataDir,
        '  端口：' + result.options.port,
        result.activated ? '  状态：已加载（登录后自动启动）' : '  状态：仅写入文件，尚未加载',
        result.activateError ? '  加载失败：' + result.activateError : '',
        '',
        activate ? '' : '如需立即启用并让登录后自动运行，请执行：',
        activate ? '' : '  launchctl bootstrap gui/$(id -u) "' + result.plistFile + '"',
        ''
      ]
        .filter(Boolean)
        .join('\n') + '\n'
    );
    return 0;
  }
  if (action === 'uninstall') {
    const result = uninstall({ activate: activate });
    process.stdout.write(
      '登录启动项已卸载：' + result.plistFile + '（文件存在时已删除：' + result.removed + '）\n'
    );
    return 0;
  }
  if (action === 'status') {
    const st = status();
    process.stdout.write(
      [
        '登录启动项状态',
        '  Label：' + st.label,
        '  文件：' + st.plistFile,
        '  已安装：' + (st.installed ? '是' : '否'),
        '  已加载：' + (st.loaded ? '是' : '否') + (st.loaded ? '' : ' — ' + st.detail)
      ].join('\n') + '\n'
    );
    return 0;
  }
  process.stderr.write('未知操作：' + action + '（可用：print | install | uninstall | status）\n');
  return 1;
}

module.exports = {
  LABEL,
  NODE_CANDIDATES,
  launchAgentsDir,
  plistPath,
  resolveNode,
  renderPlist,
  lintPlist,
  install,
  uninstall,
  status
};

if (require.main === module) {
  process.exit(cli(process.argv.slice(2)));
}
