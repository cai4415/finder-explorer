#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const FM_LABEL = IS_WIN ? '资源管理器' : IS_MAC ? '访达' : '文件管理器';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

const APP_URI = 'ui://finder-explorer/app.html';
const INLINE_URI = 'ui://finder-explorer/inline.html';
const APP_MIME_TYPE = 'text/html;profile=mcp-app';
const SERVER_INFO = { name: 'finder-explorer', version: '1.0.0' };

function parseArgs(argv) {
  let dataDir = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--data_dir=')) {
      dataDir = arg.slice('--data_dir='.length);
    } else if (arg === '--data_dir' && argv[i + 1]) {
      dataDir = argv[i + 1];
      i += 1;
    }
  }
  return { dataDir };
}

const { dataDir: DATA_DIR } = parseArgs(process.argv.slice(2));
const STATE_FILE = DATA_DIR ? path.join(DATA_DIR, 'state.json') : null;

function loadState() {
  const defaults = {
    pinnedPaths: [],
    lastPath: null,
    showHidden: false,
    folderDoubleClick: 'enter', // 'enter' | 'reveal'
  };
  if (!STATE_FILE) return defaults;
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return {
        ...defaults,
        ...parsed,
        pinnedPaths: Array.isArray(parsed.pinnedPaths) ? parsed.pinnedPaths : [],
      };
    }
  } catch {
    // Ignore corrupt state file and fall back to defaults.
  }
  return defaults;
}

function saveState(nextState) {
  if (!STATE_FILE) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(nextState, null, 2), 'utf8');
  } catch {
    // Non-fatal if persistence directory is not writable.
  }
}

let appState = loadState();

function expandPath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') return '';
  let trimmed = inputPath.trim();
  if (trimmed.startsWith('file://')) {
    try {
      trimmed = fileURLToPath(trimmed);
    } catch {
      try {
        trimmed = decodeURIComponent(new URL(trimmed).pathname);
      } catch {
        trimmed = trimmed.slice('file://'.length);
      }
      if (IS_WIN && /^\/[a-zA-Z]:/.test(trimmed)) {
        trimmed = trimmed.slice(1);
      }
    }
  }
  const home = os.homedir();
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(home, trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function getAppDataDir() {
  return process.env.ANTIGRAVITY_APP_DATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity');
}

function getBrainDir() {
  return path.join(getAppDataDir(), 'brain');
}

function pathExists(targetPath) {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isDirectoryPath(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function getQuickRoots() {
  const home = os.homedir();
  const roots = [];
  const seen = new Set();

  const pushRoot = (label, rawPath, category, badge) => {
    if (!rawPath) return;
    const resolved = expandPath(rawPath);
    if (seen.has(resolved) || !isDirectoryPath(resolved)) return;
    seen.add(resolved);
    roots.push({ label, path: resolved, category, badge: badge || null });
  };

  const cwd = process.cwd();
  const cwdRoot = cwd ? path.parse(cwd).root : '/';
  const isUsefulCwd =
    cwd &&
    cwd !== cwdRoot &&
    cwd !== PLUGIN_ROOT &&
    cwd !== home;

  if (isUsefulCwd) {
    pushRoot(path.basename(cwd) || '当前工作区', cwd, 'workspace', '工作区');
  }

  const convId = process.env.ANTIGRAVITY_CONVERSATION_ID;
  if (convId) {
    pushRoot('当前会话产物', path.join(getBrainDir(), convId), 'artifacts', '产物');
  }

  pushRoot('反重力产出目录 (brain)', getBrainDir(), 'artifacts', '产物');

  const projectsDir = path.join(home, 'Projects');
  if (isDirectoryPath(projectsDir)) {
    pushRoot('Projects', projectsDir, 'workspace', '目录');
    try {
      const projEntries = fs
        .readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => {
          const full = path.join(projectsDir, d.name);
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(full).mtimeMs;
          } catch {
            mtimeMs = 0;
          }
          return { name: d.name, full, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 6);

      for (const proj of projEntries) {
        pushRoot(proj.name, proj.full, 'recent-project', '项目');
      }
    } catch {
      // Ignore unreadable Projects directory.
    }
  }

  for (const p of appState.pinnedPaths) {
    pushRoot(path.basename(p) || p, p, 'pinned', '收藏');
  }

  pushRoot('桌面 (Desktop)', path.join(home, 'Desktop'), 'system');
  pushRoot('下载 (Downloads)', path.join(home, 'Downloads'), 'system');
  pushRoot('文稿 (Documents)', path.join(home, 'Documents'), 'system');
  pushRoot('主目录 (~)', home, 'system');

  return roots;
}

function resolveDefaultPath(requestedPath) {
  if (requestedPath) {
    const resolved = expandPath(requestedPath);
    if (isDirectoryPath(resolved)) return resolved;
    if (pathExists(resolved)) return path.dirname(resolved);
  }
  if (appState.lastPath && isDirectoryPath(appState.lastPath)) {
    return appState.lastPath;
  }
  const cwd = process.cwd();
  const cwdRoot = cwd ? path.parse(cwd).root : '/';
  if (cwd && cwd !== cwdRoot && cwd !== PLUGIN_ROOT) {
    return cwd;
  }
  const brain = getBrainDir();
  if (isDirectoryPath(brain)) return brain;
  return os.homedir();
}

function buildBreadcrumbs(dirPath) {
  const parts = [];
  let current = path.resolve(dirPath);
  while (true) {
    const parent = path.dirname(current);
    const name = path.basename(current) || current;
    parts.unshift({ name, path: current });
    if (parent === current) break;
    current = parent;
  }
  return parts;
}

function readDirectoryEntries(dirPath, options = {}) {
  const {
    showHidden = false,
    sortBy = 'name',
    sortDir = 'asc',
    query = '',
    limit = 800,
  } = options;

  const resolvedDir = path.resolve(dirPath);
  const dirents = fs.readdirSync(resolvedDir, { withFileTypes: true });
  const normalizedQuery = query.trim().toLowerCase();
  const entries = [];

  for (const dirent of dirents) {
    if (!showHidden && dirent.name.startsWith('.')) {
      continue;
    }
    if (normalizedQuery && !dirent.name.toLowerCase().includes(normalizedQuery)) {
      continue;
    }

    const fullPath = path.join(resolvedDir, dirent.name);
    let isDirectory = dirent.isDirectory();
    let isSymlink = dirent.isSymbolicLink();
    let size = 0;
    let mtimeMs = 0;

    try {
      const lstat = fs.lstatSync(fullPath);
      size = lstat.size;
      mtimeMs = lstat.mtimeMs;
      if (isSymlink) {
        try {
          const targetStat = fs.statSync(fullPath);
          isDirectory = targetStat.isDirectory();
          if (!isDirectory) size = targetStat.size;
        } catch {
          // Broken symlink stays non-directory.
        }
      }
    } catch {
      // Unreadable entry; keep minimal info.
    }

    const ext = isDirectory ? '' : path.extname(dirent.name).toLowerCase();
    entries.push({
      name: dirent.name,
      path: fullPath,
      isDirectory,
      isSymlink,
      size,
      mtimeMs,
      ext,
    });
  }

  const direction = sortDir === 'desc' ? -1 : 1;
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    if (sortBy === 'mtime') {
      if (a.mtimeMs !== b.mtimeMs) return (a.mtimeMs - b.mtimeMs) * direction;
    } else if (sortBy === 'size') {
      if (a.size !== b.size) return (a.size - b.size) * direction;
    } else if (sortBy === 'ext') {
      const extCmp = a.ext.localeCompare(b.ext);
      if (extCmp !== 0) return extCmp * direction;
    }
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }) * direction;
  });

  const totalCount = entries.length;
  const truncated = totalCount > limit;
  const sliced = truncated ? entries.slice(0, limit) : entries;
  const parentPath = path.dirname(resolvedDir) !== resolvedDir ? path.dirname(resolvedDir) : null;

  return {
    currentPath: resolvedDir,
    parentPath,
    breadcrumbs: buildBreadcrumbs(resolvedDir),
    entries: sliced,
    totalCount,
    truncated,
  };
}

function collectRecentArtifacts({ includeInternal = false, query = '', limit = 150 } = {}) {
  const brainDir = getBrainDir();
  if (!isDirectoryPath(brainDir)) {
    return { brainDir, items: [], totalConversations: 0 };
  }

  const normalizedQuery = query.trim().toLowerCase();
  const convDirs = fs
    .readdirSync(brainDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => {
      const full = path.join(brainDir, d.name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      return { id: d.name, full, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 20);

  const items = [];

  const walk = (dir, convId, convRoot, depth) => {
    if (depth > 3) return;
    let children;
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of children) {
      if (!includeInternal && entry.name.startsWith('.')) continue;
      if (!includeInternal && entry.name.endsWith('.resolved') && entry.name.includes('.metadata.json')) continue;
      if (!includeInternal && entry.name.endsWith('.metadata.json')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, convId, convRoot, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const rel = path.relative(convRoot, fullPath);
      if (normalizedQuery) {
        const hay = `${entry.name} ${rel} ${convId}`.toLowerCase();
        if (!hay.includes(normalizedQuery)) continue;
      }

      try {
        const stat = fs.statSync(fullPath);
        items.push({
          name: entry.name,
          path: fullPath,
          relativePath: rel,
          conversationId: convId,
          isCurrentConversation: convId === process.env.ANTIGRAVITY_CONVERSATION_ID,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ext: path.extname(entry.name).toLowerCase(),
        });
      } catch {
        // Ignore unreadable file.
      }
    }
  };

  for (const conv of convDirs) {
    walk(conv.full, conv.id, conv.full, 0);
  }

  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    brainDir,
    totalConversations: convDirs.length,
    items: items.slice(0, limit),
  };
}

function readAppHtml() {
  const htmlPath = process.env.FINDER_EXPLORER_APP_HTML || path.join(PLUGIN_ROOT, 'dist', 'app.html');
  return fs.readFileSync(htmlPath, 'utf8');
}

function readInlineHtml() {
  const htmlPath = process.env.FINDER_EXPLORER_INLINE_HTML || path.join(PLUGIN_ROOT, 'dist', 'inline.html');
  return fs.readFileSync(htmlPath, 'utf8');
}

function buildInlineItems(args = {}) {
  const rawPaths = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === 'string' && p.trim()) : [];
  if (rawPaths.length > 0) {
    const items = [];
    for (const raw of rawPaths.slice(0, 50)) {
      const resolved = expandPath(raw);
      if (!resolved) continue;
      let exists = false;
      let isDirectory = false;
      let isSymlink = false;
      let size = 0;
      let mtimeMs = 0;
      try {
        const lstat = fs.lstatSync(resolved);
        exists = true;
        isSymlink = lstat.isSymbolicLink();
        size = lstat.size;
        mtimeMs = lstat.mtimeMs;
        isDirectory = lstat.isDirectory();
        if (isSymlink) {
          try {
            const st = fs.statSync(resolved);
            isDirectory = st.isDirectory();
            if (!isDirectory) size = st.size;
          } catch {
            // Broken symlink
          }
        }
      } catch {
        exists = false;
      }
      items.push({
        name: path.basename(resolved) || resolved,
        path: resolved,
        parentDir: path.dirname(resolved),
        exists,
        isDirectory,
        isSymlink,
        size,
        mtimeMs,
        ext: isDirectory ? '' : path.extname(resolved).toLowerCase(),
      });
    }
    return {
      title: args.title || '产出文件列表',
      sourceDir: items[0]?.parentDir || null,
      items,
    };
  }

  if (args.directory) {
    const targetDir = resolveDefaultPath(args.directory);
    const listing = readDirectoryEntries(targetDir, {
      showHidden: appState.showHidden,
      sortBy: 'mtime',
      sortDir: 'desc',
      limit: 30,
    });
    return {
      title: args.title || `目录：${path.basename(listing.currentPath) || listing.currentPath}`,
      sourceDir: listing.currentPath,
      items: listing.entries.map((e) => ({
        ...e,
        parentDir: listing.currentPath,
        exists: true,
      })),
    };
  }

  const recent = collectRecentArtifacts({ limit: 15 });
  return {
    title: args.title || '最近 Antigravity 产出文件',
    sourceDir: recent.brainDir,
    items: recent.items.map((item) => ({
      name: item.name,
      path: item.path,
      parentDir: path.dirname(item.path),
      exists: true,
      isDirectory: false,
      isSymlink: false,
      size: item.size,
      mtimeMs: item.mtimeMs,
      ext: item.ext,
      subLabel: item.relativePath,
    })),
  };
}

const TOOLS = [
  {
    name: 'open_finder_browser',
    title: 'Finder 浏览器',
    description:
      '打开 Finder 文件浏览器面板（侧边栏或全局视图），浏览当前工作区与反重力产出目录，双击任意文件即可在系统文件管理器（Windows 资源管理器 / macOS 访达）中弹出并高亮定位该文件。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '可选：初始浏览的目录或文件路径',
        },
        mode: {
          type: 'string',
          enum: ['directory', 'artifacts'],
          description: '可选：初始视图模式（directory 目录浏览，artifacts 最近反重力产出）',
        },
      },
    },
    _meta: {
      ui: {
        resourceUri: APP_URI,
      },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'Finder 浏览器' },
          { type: 'global', title: 'Finder 浏览器' },
        ],
      },
    },
  },
  {
    name: 'show_files_inline',
    title: '消息内嵌文件卡片',
    description:
      '直接在对话消息列表内渲染可交互的文件列表卡片，用户在聊天中双击任意文件即可弹出系统文件管理器（Windows 资源管理器 / macOS 访达）并高亮选中该文件。',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '要在消息卡片中展示的文件或目录绝对路径列表',
        },
        directory: {
          type: 'string',
          description: '可选：未传 paths 时列出指定目录下的文件',
        },
        title: {
          type: 'string',
          description: '可选：卡片标题，例如“已生成文件”',
        },
      },
    },
    _meta: {
      ui: {
        resourceUri: INLINE_URI,
      },
    },
  },
  {
    name: 'list_directory',
    title: '列出目录内容',
    description: '列出指定目录下的文件与子文件夹，供 Finder 浏览器面板使用。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        showHidden: { type: 'boolean' },
        sortBy: { type: 'string', enum: ['name', 'mtime', 'size', 'ext'] },
        sortDir: { type: 'string', enum: ['asc', 'desc'] },
        query: { type: 'string' },
      },
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
  {
    name: 'get_recent_artifacts',
    title: '获取最近反重力产出',
    description: '扫描 ~/.gemini/antigravity/brain 下的最近产出文件列表。',
    inputSchema: {
      type: 'object',
      properties: {
        includeInternal: { type: 'boolean' },
        query: { type: 'string' },
      },
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
  {
    name: 'reveal_in_finder',
    title: '在文件管理器中定位显示',
    description: '在系统文件管理器（Windows 资源管理器 / macOS 访达）中定位并高亮选中指定文件或目录。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要在系统文件管理器中定位显示的文件或目录绝对路径',
        },
      },
      required: ['path'],
    },
    _meta: {
      ui: {
        visibility: ['model', 'app'],
      },
    },
  },
  {
    name: 'open_in_system',
    title: '用系统默认程序打开',
    description: '调用系统默认应用程序打开文件或直接打开目录窗口（兼容 Windows / macOS / Linux）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
  {
    name: 'update_browser_prefs',
    title: '保存面板偏好',
    description: '保存收藏路径、隐藏文件显示开关与双击文件夹行为。',
    inputSchema: {
      type: 'object',
      properties: {
        pinPath: { type: 'string' },
        unpinPath: { type: 'string' },
        showHidden: { type: 'boolean' },
        folderDoubleClick: { type: 'string', enum: ['enter', 'reveal'] },
      },
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
];

function spawnDetached(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      ...options,
    });
    let settled = false;
    child.once('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.once('spawn', () => {
      if (!settled) {
        settled = true;
        child.unref();
        resolve();
      }
    });
  });
}

async function revealInFileManager(targetPath) {
  if (IS_MAC) {
    await execFileAsync('open', ['-R', targetPath]);
    return;
  }
  if (IS_WIN) {
    const winPath = path.win32.normalize(targetPath).replace(/"/g, '');
    const isRoot = winPath === path.win32.parse(winPath).root;
    const arg = isRoot ? `"${winPath}"` : `/select,"${winPath}"`;
    await spawnDetached('explorer.exe', [arg], { windowsVerbatimArguments: true });
    return;
  }
  const openDir = isDirectoryPath(targetPath) ? targetPath : path.dirname(targetPath);
  await execFileAsync('xdg-open', [openDir]);
}

async function openWithDefaultApp(targetPath) {
  if (IS_MAC) {
    await execFileAsync('open', [targetPath]);
    return;
  }
  if (IS_WIN) {
    const winPath = path.win32.normalize(targetPath).replace(/"/g, '');
    await spawnDetached('explorer.exe', [`"${winPath}"`], { windowsVerbatimArguments: true });
    return;
  }
  await execFileAsync('xdg-open', [targetPath]);
}

async function handleToolCall(name, args = {}) {
  if (name === 'show_files_inline') {
    const inlineData = buildInlineItems(args);
    return {
      content: [
        {
          type: 'text',
          text: `已在消息中展示 ${inlineData.items.length} 个文件（${inlineData.title}），双击任意文件即可在${FM_LABEL}中定位显示。`,
        },
      ],
      structuredContent: {
        ...inlineData,
        platform: process.platform,
      },
    };
  }

  if (name === 'open_finder_browser') {
    const mode = args.mode === 'artifacts' ? 'artifacts' : 'directory';
    const targetPath = resolveDefaultPath(args.path);
    const listing = readDirectoryEntries(targetPath, {
      showHidden: appState.showHidden,
      limit: 300,
    });
    const artifacts = mode === 'artifacts' ? collectRecentArtifacts() : null;
    const roots = getQuickRoots();

    if (args.path && isDirectoryPath(targetPath)) {
      appState.lastPath = targetPath;
      saveState(appState);
    }

    return {
      content: [
        {
          type: 'text',
          text: `已打开 Finder 浏览器，当前目录：${listing.currentPath}（共 ${listing.totalCount} 项）。在面板中双击任意文件即可在${FM_LABEL}中弹出并定位。`,
        },
      ],
      structuredContent: {
        platform: process.platform,
        mode,
        listing,
        artifacts,
        roots,
        prefs: {
          showHidden: appState.showHidden,
          folderDoubleClick: appState.folderDoubleClick,
          pinnedPaths: appState.pinnedPaths,
        },
        highlightPath: args.path && !isDirectoryPath(expandPath(args.path)) ? expandPath(args.path) : null,
      },
    };
  }

  if (name === 'list_directory') {
    const targetPath = resolveDefaultPath(args.path);
    const showHidden = typeof args.showHidden === 'boolean' ? args.showHidden : appState.showHidden;
    const listing = readDirectoryEntries(targetPath, {
      showHidden,
      sortBy: args.sortBy || 'name',
      sortDir: args.sortDir || 'asc',
      query: args.query || '',
      limit: 800,
    });
    appState.lastPath = listing.currentPath;
    saveState(appState);

    return {
      content: [{ type: 'text', text: `${listing.currentPath} (${listing.totalCount})` }],
      structuredContent: {
        platform: process.platform,
        listing,
        roots: getQuickRoots(),
        prefs: {
          showHidden: appState.showHidden,
          folderDoubleClick: appState.folderDoubleClick,
          pinnedPaths: appState.pinnedPaths,
        },
      },
    };
  }

  if (name === 'get_recent_artifacts') {
    const artifacts = collectRecentArtifacts({
      includeInternal: Boolean(args.includeInternal),
      query: args.query || '',
    });
    return {
      content: [{ type: 'text', text: `共找到 ${artifacts.items.length} 个最近产出文件。` }],
      structuredContent: {
        platform: process.platform,
        artifacts,
        roots: getQuickRoots(),
      },
    };
  }

  if (name === 'reveal_in_finder') {
    const targetPath = expandPath(args.path);
    if (!targetPath || !pathExists(targetPath)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `文件或目录不存在：${args.path || '(空路径)'}` }],
      };
    }
    await revealInFileManager(targetPath);
    return {
      content: [{ type: 'text', text: `已在${FM_LABEL}中定位显示：${targetPath}` }],
      structuredContent: { ok: true, path: targetPath, action: 'reveal', platform: process.platform },
    };
  }

  if (name === 'open_in_system') {
    const targetPath = expandPath(args.path);
    if (!targetPath || !pathExists(targetPath)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `文件或目录不存在：${args.path || '(空路径)'}` }],
      };
    }
    await openWithDefaultApp(targetPath);
    return {
      content: [{ type: 'text', text: `已用系统默认方式打开：${targetPath}` }],
      structuredContent: { ok: true, path: targetPath, action: 'open', platform: process.platform },
    };
  }

  if (name === 'update_browser_prefs') {
    if (typeof args.showHidden === 'boolean') {
      appState.showHidden = args.showHidden;
    }
    if (args.folderDoubleClick === 'enter' || args.folderDoubleClick === 'reveal') {
      appState.folderDoubleClick = args.folderDoubleClick;
    }
    if (args.pinPath) {
      const resolved = expandPath(args.pinPath);
      if (isDirectoryPath(resolved) && !appState.pinnedPaths.includes(resolved)) {
        appState.pinnedPaths = [...appState.pinnedPaths, resolved];
      }
    }
    if (args.unpinPath) {
      const resolved = expandPath(args.unpinPath);
      appState.pinnedPaths = appState.pinnedPaths.filter((p) => p !== resolved);
    }
    saveState(appState);
    return {
      content: [{ type: 'text', text: '偏好已保存' }],
      structuredContent: {
        prefs: {
          showHidden: appState.showHidden,
          folderDoubleClick: appState.folderDoubleClick,
          pinnedPaths: appState.pinnedPaths,
        },
        roots: getQuickRoots(),
      },
    };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `未知工具：${name}` }],
  };
}

function sendResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function sendError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;

  // Notifications have no id and expect no response.
  if (id === undefined || id === null) {
    return;
  }

  try {
    if (method === 'initialize') {
      const protocolVersion = params?.protocolVersion || '2025-03-26';
      sendResponse(id, {
        protocolVersion,
        capabilities: {
          tools: {},
          resources: {},
        },
        serverInfo: SERVER_INFO,
      });
      return;
    }

    if (method === 'ping') {
      sendResponse(id, {});
      return;
    }

    if (method === 'tools/list') {
      sendResponse(id, { tools: TOOLS });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const result = await handleToolCall(toolName, toolArgs);
      sendResponse(id, result);
      return;
    }

    if (method === 'resources/list') {
      sendResponse(id, {
        resources: [
          {
            uri: APP_URI,
            name: 'Finder 浏览器界面',
            description: 'Antigravity 侧边栏文件浏览器，双击文件调用系统文件管理器（Windows 资源管理器 / macOS 访达）定位显示',
            mimeType: APP_MIME_TYPE,
          },
          {
            uri: INLINE_URI,
            name: '消息内嵌文件卡片',
            description: '在对话消息流中直接展示文件列表，双击任意文件弹出系统文件管理器（Windows 资源管理器 / macOS 访达）定位显示',
            mimeType: APP_MIME_TYPE,
          },
        ],
      });
      return;
    }

    if (method === 'resources/read') {
      const uri = params?.uri;
      if (uri !== APP_URI && uri !== INLINE_URI) {
        sendError(id, -32602, `Resource not found: ${uri}`);
        return;
      }
      const isInline = uri === INLINE_URI;
      const html = isInline ? readInlineHtml() : readAppHtml();
      sendResponse(id, {
        contents: [
          {
            uri,
            mimeType: APP_MIME_TYPE,
            text: html,
            _meta: {
              ui: {
                prefersBorder: isInline,
              },
            },
          },
        ],
      });
      return;
    }

    sendError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    if (method === 'tools/call') {
      sendResponse(id, {
        isError: true,
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      });
      return;
    }
    sendError(id, -32603, err instanceof Error ? err.message : String(err));
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    process.stderr.write(`Invalid JSON-RPC input: ${err}\n`);
    return;
  }
  handleMessage(parsed);
});
