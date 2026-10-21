'use strict';

/* ============================== 状态 ============================== */

const TOKEN_KEY = 'spacetime_token';

const S = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  user: null,
  stats: null,
  photos: [],
  pairs: { incoming: [], outgoing: [], rooms: [] },
  tab: 'album',
  match: null,
  room: null,
  sheet: null,
  busy: false,
};

const $ = (id) => document.getElementById(id);

/* ============================== 小工具 ============================== */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const AV_GRADS = [
  'linear-gradient(140deg,#FF7A45,#FFB35C)',
  'linear-gradient(140deg,#2A2440,#B76A5C)',
  'linear-gradient(140deg,#223A5E,#5B8FB9)',
  'linear-gradient(140deg,#5B3A72,#C4736F)',
  'linear-gradient(140deg,#3C4A57,#7C8B96)',
];

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function parts(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return { y, m, d, week: WEEK[dt.getDay()], dt };
}

function fmtDay(dateStr) {
  const p = parts(dateStr);
  return `${p.m}月${p.d}日`;
}

function fmtFull(dateStr) {
  const p = parts(dateStr);
  return `${p.y}年${p.m}月${p.d}日 · ${p.week}`;
}

function relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  return `${Math.floor(diff / 86400e3)} 天前`;
}

function haversine(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)) * 10) / 10;
}

function distLabel(km) {
  if (km == null) return '';
  if (km <= 1) return '几乎同一处';
  if (km <= 30) return '同一座城';
  return `相距 ${Math.round(km)} 公里`;
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('on'), 2400);
}

/* ============================== 请求 ============================== */

async function api(path, opts = {}) {
  const res = await fetch('/api/' + path, {
    method: opts.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(S.token ? { 'x-token': S.token } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const err = new Error(data.error || '网络出错了');
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ============================== 图标 ============================== */

const ICON = {
  album:
    '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2.6"/><circle cx="8.6" cy="10" r="1.5"/><path d="M3.4 16.4 8 12.2l3.4 2.9 3.2-2.6 6 5"/></svg>',
  meet:
    '<svg viewBox="0 0 24 24"><circle cx="9.4" cy="9.4" r="5.9"/><circle cx="14.6" cy="14.6" r="5.9"/></svg>',
  swap:
    '<svg viewBox="0 0 24 24"><path d="M4 8.5h13.5L14.5 5.5M20 15.5H6.5L9.5 18.5"/></svg>',
  me: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.6" r="3.7"/><path d="M4.9 20c1.2-3.7 3.9-5.6 7.1-5.6s5.9 1.9 7.1 5.6"/></svg>',
};

/* ============================== 登录 ============================== */

const GUEST_NAMES = ['拾光的人', '晚风', '云上', '长街', '半山', '看天的人'];

function authView() {
  return `
  <div class="auth">
    <div class="sun"></div>
    <h2>在不相识的日子里，<br/><em>我们看过同一片天。</em></h2>
    <p class="lead">授权你的相册，我们只读取每张照片的<b>拍摄日期</b>与<b>大致地点</b>。<br/>
    随机抽一个日子，找到那天也在拍照的另一个人 —— 双方都同意后，才交换那一天的照片。</p>
    <input id="name-input" maxlength="16" placeholder="给自己起个名字" autocomplete="off" />
    <button class="btn primary block" data-act="login">进入时空相册</button>
    <button class="btn ghost block" style="margin-top:10px" data-act="guest">先随便逛逛</button>
    <div class="hint">不需要手机号，昵称就是你的身份。<br/>换台设备用同名进入即可继续。</div>
  </div>`;
}

/* ============================== 外壳 ============================== */

function shell() {
  const tabs = [
    ['album', '相册', ICON.album],
    ['meet', '遇见', ICON.meet],
    ['pairs', '交换', ICON.swap],
    ['me', '我', ICON.me],
  ];
  const badge = S.pairs.incoming.length
    ? '<i class="dot"></i>'
    : '';
  const sub = {
    album: '只上传时间与地点，原图留在本地',
    meet: '抽一个日子，看看谁也在拍',
    pairs: '双方都同意，照片才会互相可见',
    me: '你的授权范围，随时可以收回',
  }[S.tab];

  return `
  <div class="topbar">
    <div>
      <h1>时空相册</h1>
      <div class="sub">${sub}</div>
    </div>
    <div class="avatar" style="background:${AV_GRADS[hash(S.user.id) % AV_GRADS.length]}">
      ${esc(S.user.name.slice(0, 1))}
    </div>
  </div>
  <main id="view">${tabView()}</main>
  <nav class="tabbar">
    ${tabs
      .map(
        ([k, label, icon]) => `
      <button data-act="tab" data-tab="${k}" class="${S.tab === k ? 'on' : ''}">
        ${icon}<span>${label}</span>${k === 'pairs' ? badge : ''}
      </button>`
      )
      .join('')}
  </nav>`;
}

function tabView() {
  if (S.tab === 'album') return albumView();
  if (S.tab === 'meet') return meetView();
  if (S.tab === 'pairs') return pairsView();
  return meView();
}

/* ============================== 相册 ============================== */

function albumView() {
  const st = S.stats || { photos: 0, dates: 0 };
  const years =
    st.firstDate && st.lastDate
      ? new Date(st.lastDate).getFullYear() - new Date(st.firstDate).getFullYear() + 1
      : 0;

  const groups = {};
  for (const p of S.photos) (groups[p.date] ||= []).push(p);
  const days = Object.keys(groups).sort().reverse();

  return `
  <div class="hero">
    <div class="cap">MY SPACETIME ALBUM</div>
    <div style="font-size:15px;font-weight:600;margin-top:8px;position:relative;z-index:1">
      你授权了 ${st.dates} 个日子
    </div>
    <div class="nums">
      <div><b>${st.photos}</b><span>张照片</span></div>
      <div><b>${st.dates}</b><span>个拍摄日</span></div>
      <div><b>${years || '—'}</b><span>年跨度</span></div>
    </div>
  </div>

  <div class="import-card">
    <p>系统只读取「拍摄时间 + 大致地点」，<br/>缩略图加密保存在你的空间，原图不会上传。</p>
    <div class="row">
      <button class="btn primary" data-act="pick-files">选择照片</button>
      <button class="btn ghost" data-act="pick-folder">整个相册</button>
    </div>
  </div>

  ${
    S.photos.length === 0
      ? `<div class="empty">还没有授权的照片。<br/>先选几张，或者载入一份示例相册试试看。<br/><br/>
         <button class="btn ghost" data-act="load-sample">载入示例相册</button></div>`
      : `<div class="section-title">按日子</div>${days.map((d) => dayGroup(d, groups[d])).join('')}
         <div class="foot-note">在「我」里可以随时清空这些授权。</div>`
  }`;
}

function dayGroup(date, list) {
  const p = parts(date);
  const place = list.find((x) => x.place)?.place || '';
  const approx = list.some((x) => x.approx);
  return `
  <div class="day">
    <div class="day-head">
      <span class="d">${p.m}月${p.d}日</span>
      <span class="w">${p.week}${approx ? ' · 日期约' : ''}</span>
      <span class="place">${esc(place)}</span>
    </div>
    <div class="thumbs">
      ${list
        .map(
          (ph) =>
            `<img src="${ph.thumb}" alt="" loading="lazy" data-act="view" data-id="${ph.id}" />`
        )
        .join('')}
    </div>
  </div>`;
}

/* ============================== 遇见 ============================== */

function meetView() {
  return `
  <div class="card roll">
    <button class="dial ${S.busy ? 'spin' : ''}" data-act="roll">随机<br/>一天</button>
    <h3>把日历交给偶然</h3>
    <p>从你的相册里随机抽一个日子，<br/>看看那一天，谁也在按下快门。</p>
  </div>

  <div class="card">
    <div class="range-form">
      <input type="date" id="range-from" />
      <span class="muted">→</span>
      <input type="date" id="range-to" />
    </div>
    <button class="btn ghost block" data-act="match-range">在这段时间里找</button>
  </div>

  ${matchResultView()}`;
}

function matchResultView() {
  if (!S.match) return '';
  const m = S.match;

  if (m.mode === 'random') {
    const p = parts(m.date);
    const mine = S.photos.filter((x) => x.date === m.date).length;
    return `
    <div class="picked-date">
      <div class="y">${p.y}</div>
      <div class="big">${p.m}月${p.d}日</div>
      <div class="note">${p.week} · 这一天你拍了 ${mine} 张</div>
    </div>
    ${
      m.candidates.length
        ? `<div class="section-title">那一天，也有人在拍</div>${m.candidates
            .map((c) => candCard(c))
            .join('')}`
        : `<div class="card empty">这一天你的相册是满的，<br/>但还没有人和你重合。<br/>换个日子，或者多授权几张照片。</div>`
    }`;
  }

  return `
  <div class="section-title">这段时间里重合的 ${m.dates.length} 个日子</div>
  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
    ${m.dates
      .slice(0, 12)
      .map((d) => `<span class="chip">${fmtDay(d)}</span>`)
      .join('')}
    ${m.dates.length > 12 ? `<span class="chip">+${m.dates.length - 12}</span>` : ''}
  </div>
  ${
    m.candidates.length
      ? m.candidates.map((c) => candCard(c)).join('')
      : `<div class="card empty">这段时间里还没有找到重合的人。</div>`
  }`;
}

function candCard(c) {
  const g = AV_GRADS[hash(c.user.id) % AV_GRADS.length];
  const close = c.distanceKm != null && c.distanceKm <= 50;
  const meta = [`${c.overlap.length} 个日子重合`];
  if (c.distanceKm != null) meta.push(distLabel(c.distanceKm));
  return `
  <div class="cand">
    <div class="av" style="background:${g}">${esc(c.user.name.slice(0, 1))}</div>
    <div class="info">
      <div class="name">${esc(c.user.name)}${
        close
          ? '<span class="chip" style="font-size:10px;padding:2px 7px;border-color:rgba(255,107,69,.35);color:#e2603f">同一片天</span>'
          : ''
      }</div>
      <div class="meta">${meta.join(' · ')}</div>
    </div>
    <button class="go" data-act="start-pair" data-uid="${c.user.id}"
      data-dates="${c.overlap.join(',')}" data-name="${esc(c.user.name)}">交换</button>
  </div>`;
}

/* ============================== 交换 ============================== */

function pairsView() {
  const { incoming, outgoing, rooms } = S.pairs;
  if (!incoming.length && !outgoing.length && !rooms.length) {
    return `<div class="empty" style="padding-top:60px">
      还没有进行中的交换。<br/>去「遇见」抽一个日子，<br/>看看谁和你在同一天抬头。
      <br/><br/><button class="btn primary" data-act="tab" data-tab="meet">去抽取一个日子</button>
    </div>`;
  }
  return `
  ${incoming.length ? `<div class="section-title">有人想和你交换</div>${incoming.map(pairCard).join('')}` : ''}
  ${rooms.length ? `<div class="section-title">正在交换</div>${rooms.map(pairCard).join('')}` : ''}
  ${outgoing.length ? `<div class="section-title">等一个回应</div>${outgoing.map(pairCard).join('')}` : ''}`;
}

function pairCard(p) {
  const g = AV_GRADS[hash(p.partner.id) % AV_GRADS.length];
  const chips = p.dates.slice(0, 4).map((d) => `<span class="chip">${fmtDay(d)}</span>`).join('');
  const more = p.dates.length > 4 ? `<span class="chip">+${p.dates.length - 4}</span>` : '';

  let status = '';
  let acts = '';
  if (p.status === 'pending' && !p.iAmInitiator) {
    status = '<span style="color:#ff6b45">等你回应</span>';
    acts = `<button class="btn ghost" data-act="respond" data-id="${p.id}" data-accept="0">婉拒</button>
            <button class="btn primary" data-act="respond" data-id="${p.id}" data-accept="1">接受交换</button>`;
  } else if (p.status === 'pending') {
    status = '等待 TA 回应…';
  } else {
    status = p.canSee
      ? '照片已互相可见'
      : p.mine
        ? '已展示 · 等 TA 也按下展示'
        : '等双方展示照片';
    acts = `<button class="btn dark" data-act="open-room" data-id="${p.id}">进入交换</button>`;
  }

  return `
  <div class="pair-card">
    <div class="top">
      <div class="av" style="background:${g}">${esc(p.partner.name.slice(0, 1))}</div>
      <div>
        <div class="t">${esc(p.partner.name)}</div>
        <div class="s">${p.dates.length} 个共同的日子 · ${status}</div>
      </div>
    </div>
    <div class="dates">${chips}${more}</div>
    <div class="acts">${acts}</div>
  </div>`;
}

/* ============================== 我 ============================== */

function meView() {
  const st = S.stats || { photos: 0, dates: 0 };
  return `
  <div class="stats-row">
    <div class="stat"><b>${st.photos}</b><span>授权照片</span></div>
    <div class="stat"><b>${st.dates}</b><span>拍摄日</span></div>
    <div class="stat"><b>${S.pairs.rooms.length}</b><span>交换中</span></div>
  </div>

  <div class="card">
    <div style="display:flex;align-items:center;gap:12px">
      <div style="width:44px;height:44px;border-radius:50%;display:grid;place-items:center;
        color:#fff;font-size:17px;font-weight:600;background:${AV_GRADS[hash(S.user.id) % AV_GRADS.length]}">
        ${esc(S.user.name.slice(0, 1))}
      </div>
      <div>
        <div style="font-size:16px;font-weight:600">${esc(S.user.name)}</div>
        <div class="muted" style="font-size:11.5px;margin-top:3px">匿名身份 · ${S.user.id.slice(0, 12)}</div>
      </div>
    </div>
  </div>

  <div class="card">
    <div style="font-size:14px;font-weight:600;margin-bottom:8px">我们拿走了什么</div>
    <div style="font-size:12.5px;color:var(--ink-2);line-height:2">
      · 每张照片的<b>拍摄日期</b>和<b>大致地点</b>（如果照片里带着 GPS）<br/>
      · 一张压缩过的缩略图，用于在交换时展示<br/>
      · 原始照片始终留在你的设备上，不会被上传
    </div>
  </div>

  <div class="card">
    <div style="font-size:14px;font-weight:600;margin-bottom:8px">交换规则</div>
    <div style="font-size:12.5px;color:var(--ink-2);line-height:2">
      匹配时只比对日期，看不到任何照片。<br/>
      只有当双方都按下「展示」之后，那一天的照片才会互相可见。<br/>
      你可以随时清空授权，进行中的交换也会一并结束。
    </div>
  </div>

  <button class="btn ghost block" style="margin-bottom:10px" data-act="reset">清空我的授权</button>
  <button class="btn ghost block" data-act="logout">换个身份</button>
  <div class="foot-note" style="padding-top:18px">时空相册 · 同一天，我们各自抬头</div>`;
}

/* ============================== 绘制 ============================== */

function paint(keepScroll) {
  const y = keepScroll ? window.scrollY : 0;
  $('app').innerHTML = S.user ? shell() : authView();
  paintLayer();
  if (keepScroll) window.scrollTo(0, y);
  else window.scrollTo(0, 0);
}

function paintLayer() {
  let html = '';
  if (S.room) html += roomView(S.room);
  if (S.sheet) html += sheetView();
  if (S.viewer) html += viewerView();
  $('layer').innerHTML = html;
}

function roomView(data) {
  const { pair, canSee, groups } = data;
  const totalMine = groups.reduce((n, g) => n + g.mine.length, 0);

  return `
  <div class="room">
    <div class="room-head">
      <button data-act="close-room">‹</button>
      <div class="who">与 ${esc(pair.partner.name)} 的交换</div>
    </div>
    <div class="room-body">
      <div class="room-hero">
        <div class="big">${
          pair.dates.length === 1
            ? '你们在同一个日子里，<br/>同时按下了快门。'
            : `你们在 ${pair.dates.length} 个日子里，<br/>同时按下了快门。`
        }</div>
        <div class="small">${pair.dates
          .slice(0, 3)
          .map(fmtDay)
          .join(' · ')}${pair.dates.length > 3 ? ' …' : ''}</div>
      </div>

      ${
        !pair.mine
          ? `<div class="reveal-box">
               <p>按下展示后，这 ${totalMine} 张照片会对 TA 可见。<br/>TA 也需要做同样的一次确认，你才能看到 TA 的那一天。</p>
               <button class="btn primary block" data-act="reveal" data-id="${pair.id}">展示这些日子的照片</button>
             </div>`
          : ''
      }

      ${
        pair.mine && !pair.theirs
          ? `<div class="reveal-box"><div class="waiting"><i></i>已展示 · 等 TA 也按下展示</div></div>`
          : ''
      }

      ${groups.map((g) => roomDay(g, pair, canSee)).join('')}

      ${
        canSee
          ? `<div class="foot-note">这些照片来自两个陌生人的同一天。<br/>请不要保存、转发或用于其他地方。</div>`
          : ''
      }
    </div>
  </div>`;
}

function roomDay(g, pair, canSee) {
  const p = parts(g.date);

  // 同一天里两人最近的距离，作为「同一片天」的注脚
  let near = null;
  if (canSee) {
    for (const a of g.mine) {
      for (const b of g.theirs) {
        const d = haversine(a, b);
        if (d != null && (near === null || d < near)) near = d;
      }
    }
  }
  const mineTimes = g.mine.map((x) => x.time).filter(Boolean).sort();
  const timeNote = mineTimes.length ? `你在 ${mineTimes[0]} 按下快门` : '';

  return `
  <div class="same-day">
    <div class="label">
      <b>${p.m}月${p.d}日</b>
      <span>${p.week}${near != null ? ' · ' + distLabel(near) : ''}</span>
      <span class="ago">${timeNote}</span>
    </div>
    <div class="two-col">
      <div class="col">
        <h4><i class="who-dot"></i>你</h4>
        <div class="imgs ${g.mine.length === 1 ? 'one' : ''}">
          ${g.mine
            .map(
              (ph) =>
                `<img src="${ph.thumb}" alt="" data-act="view" data-id="${ph.id}" data-own="1" />`
            )
            .join('')}
        </div>
      </div>
      <div class="col">
        <h4>${esc(pair.partner.name)}</h4>
        ${
          canSee
            ? `<div class="imgs ${g.theirs.length === 1 ? 'one' : ''}">
                 ${g.theirs
                   .map((ph) => `<img src="${ph.thumb}" alt="" data-act="view" data-id="${ph.id}" />`)
                   .join('')}
               </div>`
            : `<div class="lock">🔒<span>TA 还没展示<br/>这一天</span></div>`
        }
      </div>
    </div>
  </div>`;
}

function sheetView() {
  const { dates, sel, partnerName } = S.sheet;
  return `
  <div class="sheet-mask" data-act="close-sheet">
    <div class="sheet">
      <h3>选择与 ${esc(partnerName)} 交换的日子</h3>
      <p class="sub">只有被选中的日子，才会在双方都确认后互相可见。</p>
      <div class="pick-list">
        ${dates
          .map(
            (d) => `
          <div class="pick ${sel.has(d) ? 'on' : ''}" data-act="toggle-date" data-date="${d}">
            <div class="box">${sel.has(d) ? '✓' : ''}</div>
            <div class="txt"><b>${fmtFull(d)}</b><span>这一天你也拍了照片</span></div>
          </div>`
          )
          .join('')}
      </div>
      <button class="btn primary block" data-act="confirm-pair" ${sel.size ? '' : 'disabled'}>
        发起交换（已选 ${sel.size} 个日子）
      </button>
    </div>
  </div>`;
}

function viewerView() {
  const ph = S.photos.find((x) => x.id === S.viewer.id) || S.viewer.photo;
  if (!ph) return '';
  const p = parts(ph.date);
  return `
  <div class="viewer" data-act="close-viewer">
    <button class="close" data-act="close-viewer">✕</button>
    <div class="stage"><img src="${ph.thumb}" alt="" /></div>
    <div class="foot">
      <div>${p.y}年${p.m}月${p.d}日 ${p.week}${ph.time ? ' · ' + ph.time : ''}<br/>
        ${esc(ph.place || '未记录地点')}${ph.approx ? ' · 日期取自文件时间' : ''}</div>
      ${S.viewer.own ? `<button data-act="delete-photo" data-id="${ph.id}">取消授权</button>` : ''}
    </div>
  </div>`;
}

/* ============================== 导入 ============================== */

function pickFiles(folder) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  if (folder) {
    input.webkitdirectory = true;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }
  input.onchange = () => {
    if (input.files && input.files.length) handleFiles(input.files);
  };
  input.click();
}

async function makeThumb(file, max = 640) {
  let bmp = null;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bmp = null;
  }
  if (!bmp) {
    bmp = await new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }
  if (!bmp) return null;

  const w = bmp.width || bmp.naturalWidth;
  const h = bmp.height || bmp.naturalHeight;
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  if (bmp.close) bmp.close();
  return canvas.toDataURL('image/jpeg', 0.72);
}

function showProgress(text, file) {
  $('layer').insertAdjacentHTML(
    'beforeend',
    `<div class="progress" id="progress"><div><div class="ring"></div>
      <p id="progress-text">${esc(text)}</p>
      <p style="font-size:11px;opacity:.6;margin-top:6px" id="progress-file">${esc(file || '')}</p>
    </div></div>`
  );
}

function updateProgress(text, file) {
  const t = $('progress-text');
  if (t) t.textContent = text;
  const f = $('progress-file');
  if (f) f.textContent = file || '';
}

function hideProgress() {
  const el = $('progress');
  if (el) el.remove();
}

async function handleFiles(fileList) {
  const all = [...fileList].filter(
    (f) => /^image\//.test(f.type) || /\.(jpe?g|png|heic|heif|webp|tiff?)$/i.test(f.name)
  );
  if (!all.length) return toast('没有找到可读取的图片');
  const batch = all.slice(0, 120);

  showProgress(`正在读取 0/${batch.length}`);
  const collected = [];
  let skipped = 0;

  for (let i = 0; i < batch.length; i++) {
    if (i % 3 === 0) {
      updateProgress(`正在读取 ${i + 1}/${batch.length}`, batch[i].name);
      await new Promise((r) => setTimeout(r, 0));
    }
    try {
      const meta = await SpaceExif.fromFile(batch[i]);
      const thumb = await makeThumb(batch[i]);
      if (!thumb) {
        skipped++;
        continue;
      }
      collected.push({ ...meta, thumb });
    } catch {
      skipped++;
    }
  }

  if (!collected.length) {
    hideProgress();
    return toast(skipped ? '这些格式在浏览器里解不开，试试 JPEG' : '没有读到照片');
  }

  updateProgress(`正在加密保存 ${collected.length} 张…`);
  try {
    for (let i = 0; i < collected.length; i += 10) {
      await api('photos', { method: 'POST', body: { photos: collected.slice(i, i + 10) } });
    }
    await loadPhotos();
  } catch (err) {
    hideProgress();
    return toast(err.message);
  }

  hideProgress();
  paint();
  toast(
    skipped
      ? `已授权 ${collected.length} 张，${skipped} 张格式不支持已跳过`
      : `已授权 ${collected.length} 张照片`
  );
}

/* ============================== 数据 ============================== */

async function loadPhotos() {
  const d = await api('photos');
  S.photos = d.photos;
  S.stats = d.stats;
}

async function loadPairs() {
  const d = await api('pairs');
  S.pairs = { incoming: d.incoming, outgoing: d.outgoing, rooms: d.rooms };
}

async function openRoom(id) {
  S.room = null;
  try {
    S.room = await api('pairs/' + id);
    document.body.style.overflow = 'hidden';
    paintLayer();
  } catch (err) {
    toast(err.message);
  }
}

/* ============================== 动作 ============================== */

async function doLogin(name) {
  try {
    const d = await api('login', { method: 'POST', body: { name } });
    S.token = d.token;
    localStorage.setItem(TOKEN_KEY, d.token);
    S.user = d.user;
    S.stats = d.stats;
    S.photos = [];
    await loadPhotos().catch(() => {});
    await loadPairs().catch(() => {});
    paint();
    toast(`你好，${d.user.name}`);
  } catch (err) {
    toast(err.message);
  }
}

const actions = {
  tab(el) {
    S.tab = el.dataset.tab;
    if (S.tab !== 'meet') S.match = null;
    paint();
  },

  async login() {
    const name = ($('name-input').value || '').trim();
    if (!name) return toast('先给自己起个名字吧');
    return doLogin(name);
  },

  guest() {
    const name = GUEST_NAMES[Math.floor(Math.random() * GUEST_NAMES.length)] +
      String(Math.floor(Math.random() * 90) + 10);
    return doLogin(name);
  },

  'pick-files': () => pickFiles(false),
  'pick-folder': () => pickFiles(true),

  async 'load-sample'() {
    showProgress('正在生成一份示例相册…');
    try {
      await api('demo/sample', { method: 'POST' });
      await loadPhotos();
      hideProgress();
      paint();
      toast('示例相册已载入，去「遇见」试试');
    } catch (err) {
      hideProgress();
      toast(err.message);
    }
  },

  view(el) {
    const id = el.dataset.id;
    const ph = S.photos.find((x) => x.id === id);
    if (ph) {
      S.viewer = { id, photo: ph, own: true };
    } else {
      // 对方的照片：从房间里找
      const found = S.room?.groups.flatMap((g) => (g.theirs || []).concat(g.mine)).find((x) => x.id === id);
      if (!found) return;
      S.viewer = { id, photo: found, own: false };
    }
    paintLayer();
  },

  'close-viewer'() {
    S.viewer = null;
    paintLayer();
  },

  async 'delete-photo'(el) {
    try {
      await api('photos/' + el.dataset.id, { method: 'DELETE' });
      S.viewer = null;
      await loadPhotos();
      paint();
      toast('已取消这张照片的授权');
    } catch (err) {
      toast(err.message);
    }
  },

  async roll() {
    if (S.busy) return;
    S.busy = true;
    S.match = null;
    paint(true);
    const t0 = Date.now();
    try {
      const d = await api('match', { method: 'POST', body: { mode: 'random' } });
      const wait = Math.max(0, 900 - (Date.now() - t0));
      await new Promise((r) => setTimeout(r, wait));
      S.match = d;
    } catch (err) {
      toast(err.message);
    }
    S.busy = false;
    paint(true);
    if (S.match) document.querySelector('.picked-date')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  async 'match-range'() {
    const from = $('range-from')?.value || '';
    const to = $('range-to')?.value || '';
    if (!from && !to) return toast('选一个开始和结束的日子');
    try {
      const d = await api('match', { method: 'POST', body: { mode: 'range', from, to } });
      S.match = d;
      paint(true);
      if (!d.candidates.length) toast('这段时间里还没有重合的人');
    } catch (err) {
      toast(err.message);
    }
  },

  'start-pair'(el) {
    const dates = el.dataset.dates.split(',').filter(Boolean).sort();
    S.sheet = {
      toUserId: el.dataset.uid,
      partnerName: el.dataset.name,
      dates,
      sel: new Set(dates),
    };
    paintLayer();
  },

  'toggle-date'(el) {
    const d = el.dataset.date;
    if (S.sheet.sel.has(d)) S.sheet.sel.delete(d);
    else S.sheet.sel.add(d);
    paintLayer();
  },

  'close-sheet'() {
    S.sheet = null;
    paintLayer();
  },

  async 'confirm-pair'() {
    const { toUserId, sel } = S.sheet;
    if (!sel.size) return;
    try {
      await api('pairs', {
        method: 'POST',
        body: { toUserId, dates: [...sel] },
      });
      S.sheet = null;
      await loadPairs();
      S.tab = 'pairs';
      paint();
      toast('请求已发出，等 TA 回应');
    } catch (err) {
      S.sheet = null;
      paintLayer();
      toast(err.message);
      await loadPairs().catch(() => {});
    }
  },

  async respond(el) {
    const accept = el.dataset.accept === '1';
    try {
      await api(`pairs/${el.dataset.id}/respond`, { method: 'POST', body: { accept } });
      await loadPairs();
      paint();
      if (accept) {
        toast('已同意，进入交换');
        const p = S.pairs.rooms.find((r) => r.id === el.dataset.id);
        if (p) openRoom(p.id);
      } else {
        toast('已婉拒');
      }
    } catch (err) {
      toast(err.message);
    }
  },

  'open-room'(el) {
    openRoom(el.dataset.id);
  },

  'close-room'() {
    S.room = null;
    document.body.style.overflow = '';
    loadPairs().then(() => paint()).catch(() => paint());
  },

  async reveal(el) {
    try {
      await api(`pairs/${el.dataset.id}/reveal`, { method: 'POST' });
      await openRoom(el.dataset.id);
      await loadPairs();
      toast('已展示，等 TA 也按下展示');
    } catch (err) {
      toast(err.message);
    }
  },

  async reset() {
    if (!confirm('清空你所有已授权的照片？进行中的交换也会结束。')) return;
    try {
      await api('reset', { method: 'POST' });
      await loadPhotos();
      await loadPairs();
      S.match = null;
      paint();
      toast('已清空');
    } catch (err) {
      toast(err.message);
    }
  },

  logout() {
    if (!confirm('换个身份？当前授权会保留在这个昵称下。')) return;
    localStorage.removeItem(TOKEN_KEY);
    S.token = '';
    S.user = null;
    S.photos = [];
    S.pairs = { incoming: [], outgoing: [], rooms: [] };
    S.match = null;
    S.room = null;
    paint();
  },
};

/* ============================== 事件 ============================== */

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;

  // 点击遮罩关闭弹层（但点内容区不关）
  if (act === 'close-sheet' && !e.target.classList.contains('sheet-mask')) return;

  const fn = actions[act];
  if (!fn) return;
  e.preventDefault();
  e.stopPropagation();
  fn(el);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && $('name-input') && document.activeElement === $('name-input')) {
    actions.login();
  }
  if (e.key === 'Escape') {
    if (S.viewer) actions['close-viewer']();
    else if (S.sheet) actions['close-sheet']();
    else if (S.room) actions['close-room']();
  }
});

/* ============================== 启动 ============================== */

// 停留在「交换」页或房间里时，轻量轮询：让对方的回应与展示实时出现
setInterval(async () => {
  if (!S.user || S.sheet || S.viewer || S.busy) return;
  if (S.tab !== 'pairs' && !S.room) return;
  try {
    const before = JSON.stringify(S.pairs);
    await loadPairs();
    let dirty = JSON.stringify(S.pairs) !== before;

    if (S.room) {
      const fresh = await api('pairs/' + S.room.pair.id);
      if (JSON.stringify(fresh) !== JSON.stringify(S.room)) {
        S.room = fresh;
        dirty = true;
      }
    }
    if (dirty) paint(true);
  } catch {
    /* 忽略轮询失败 */
  }
}, 4000);

async function boot() {
  paint();
  if (!S.token) return;
  try {
    const d = await api('me');
    S.user = d.user;
    S.stats = d.stats;
    await loadPhotos();
    await loadPairs();
    paint();
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    S.token = '';
    S.user = null;
    paint();
  }
}

boot();
