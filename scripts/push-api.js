#!/usr/bin/env node
/**
 * 用 GitHub Git Data API 推送本地提交。
 *
 * 这个网络环境下 `git push` 走 https 经常报 `Empty reply from server`，
 * 镜像（gh-proxy）又不放行写入。api.github.com 反而是通的，所以把本地提交
 * 逐条重放成 GitHub 对象再更新 ref。
 *
 * 用法：
 *   node scripts/push-api.js                 # 推送 main
 *   node scripts/push-api.js --branch main --remote origin
 *
 * 身份从 `gh auth token` 拿，不落盘、不打印。
 */

const { execFileSync } = require('child_process');

const API = 'https://api.github.com';
const TOKEN = process.env.GH_TOKEN_FOR_API || readToken();

function readToken() {
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch (e) {
    die('拿不到 GitHub 凭据：先跑 gh auth login');
  }
}

function die(msg) {
  console.error('✖ ' + msg);
  process.exit(1);
}

function git(args, opts = {}) {
  return execFileSync('git', args, {
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
}

function gitText(args) {
  return git(args, { encoding: 'utf8' });
}

async function api(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    die(`${init.method || 'GET'} ${path} → ${res.status} ${body.message || text.slice(0, 200)}`);
  }
  return body;
}

/** 把 https://github.com/owner/repo.git 解析成 owner/repo */
function parseRemote(url) {
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) die(`认不出这个 remote：${url}`);
  return `${m[1]}/${m[2]}`;
}

/** 一次 diff 里改动的文件，按状态分组。用 -z 避免中文路径被转义加引号。 */
function changedFiles(from, to) {
  const split = (out) => out.split('\0').filter(Boolean);

  const touched = split(
    gitText(['diff', '--name-only', '-z', '--diff-filter=ACMRT', from, to]),
  );
  const deleted = split(gitText(['diff', '--name-only', '-z', '--diff-filter=D', from, to]));
  return { touched, deleted };
}

function fileMode(commit, path) {
  const out = gitText(['ls-tree', commit, '--', path]).trim();
  if (!out) return '100644';
  return out.split(/\s+/)[0];
}

async function createBlob(commit, path) {
  const buf = git(['show', `${commit}:${path}`]);
  const b64 = buf.toString('base64');
  const r = await api('/repos/' + REPO + '/git/blobs', {
    method: 'POST',
    body: JSON.stringify({ content: b64, encoding: 'base64' }),
  });
  return r.sha;
}

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : dflt;
  };

  const branch = getArg('--branch', 'main');
  const remoteName = getArg('--remote', 'origin');

  const remoteUrl = gitText(['remote', 'get-url', remoteName]).trim();
  global.REPO = parseRemote(remoteUrl);

  const head = gitText(['rev-parse', 'HEAD']).trim();
  const remoteRef = await api(`/repos/${REPO}/git/ref/heads/${branch}`);
  const remoteHead = remoteRef.object.sha;

  // 远端那个提交是本脚本用 API 造的，本地没有它的对象，
  // 所以不能直接拿 sha 做祖先判断 —— 改用 tree 对齐：找出内容与远端一致的本地提交。
  const remoteCommit = await api(`/repos/${REPO}/git/commits/${remoteHead}`);
  const remoteTree = remoteCommit.tree.sha;

  const localLog = gitText(['rev-list', 'HEAD']).split('\n').filter(Boolean);
  let baseLocal = null;
  for (const c of localLog) {
    if (gitText(['rev-parse', `${c}^{tree}`]).trim() === remoteTree) {
      baseLocal = c;
      break;
    }
  }

  if (!baseLocal) {
    die(
      `远端 ${branch}(${remoteHead.slice(0, 7)}) 的内容在本地找不到对应提交，` +
        '两边已经分叉，不能快进推送',
    );
  }

  const commits = gitText(['rev-list', '--reverse', `${baseLocal}..${head}`])
    .split('\n')
    .filter(Boolean);

  if (baseLocal === head || !commits.length) {
    console.log('✓ 远端内容与本地一致，无需推送');
    return;
  }

  console.log(`仓库 ${REPO}  分支 ${branch}`);
  console.log(
    `远端 ${remoteHead.slice(0, 7)}（内容同本地 ${baseLocal.slice(0, 7)}）→ 本地 ${head.slice(0, 7)}，` +
      `共 ${commits.length} 个提交\n`,
  );

  let parentTree = remoteTree;
  let parentSha = remoteHead;

  for (const sha of commits) {
    const subject = gitText(['log', '-1', '--format=%s', sha]).trim();
    const localParent = gitText(['rev-parse', `${sha}^`]).trim();
    const { touched, deleted } = changedFiles(localParent, sha);

    const entries = [];
    for (const path of touched) {
      const blob = await createBlob(sha, path);
      entries.push({ path, mode: fileMode(sha, path), type: 'blob', sha: blob });
    }
    for (const path of deleted) {
      entries.push({ path, mode: '100644', type: 'blob', sha: null });
    }

    const tree = await api(`/repos/${REPO}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ base_tree: parentTree, tree: entries }),
    });

    const raw = gitText(['log', '-1', '--format=%an%n%ae%n%aI%n%B', sha]);
    const nl = raw.indexOf('\n');
    const authorName = raw.slice(0, nl);
    const rest1 = raw.slice(nl + 1);
    const nl2 = rest1.indexOf('\n');
    const authorEmail = rest1.slice(0, nl2);
    const rest2 = rest1.slice(nl2 + 1);
    const nl3 = rest2.indexOf('\n');
    const authorDate = rest2.slice(0, nl3);
    const message = rest2.slice(nl3 + 1);

    const commit = await api(`/repos/${REPO}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message,
        tree: tree.sha,
        parents: [parentSha],
        author: { name: authorName, email: authorEmail, date: authorDate },
        committer: { name: authorName, email: authorEmail, date: authorDate },
      }),
    });

    console.log(`✓ ${sha.slice(0, 7)} ${subject}`);
    console.log(`  ${touched.length} 改 / ${deleted.length} 删 → tree ${tree.sha.slice(0, 7)}`);

    parentTree = tree.sha;
    parentSha = commit.sha;
  }

  await api(`/repos/${REPO}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: parentSha, force: false }),
  });

  // 这些提交是 API 造的，本地没有对象，所以 refs/remotes 指不过去（git 会拒绝）。
  // 下一次运行靠 tree 对齐识别，不依赖本地跟踪引用，这里只是尽力而为。
  try {
    git(['cat-file', '-e', `${parentSha}^{commit}`]);
    git(['update-ref', `refs/remotes/${remoteName}/${branch}`, parentSha]);
  } catch {
    /* 本地没有这个对象，正常 */
  }

  console.log(`\n✓ 已推送 ${branch} → ${parentSha.slice(0, 7)}`);
}

main().catch((e) => die(e.message));
