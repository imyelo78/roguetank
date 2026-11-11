import { RARITY } from './upgrades.js';
import { CHASSIS_LIST, CHASSIS, normalizeChassisId } from './chassis.js';
import { loadCallsign, saveCallsign, todayKey, fetchAll, fetchDay, getPid } from './daily.js';
import { BUILD } from './core/protocol.js';

const $ = (id) => document.getElementById(id);

const fmtTime = (ms) => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** 复制到剪贴板，带老浏览器降级 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
}

/** 邀请链接：当前页面地址 + 房间码参数，打开就能自动填好房号 */
function buildInviteLink(room) {
  try {
    const u = new URL(location.href);
    u.search = '';
    u.hash = '';
    if (room) u.searchParams.set('room', room);
    return u.toString();
  } catch {
    return location.href;
  }
}

const esc = (str) => String(str == null ? '' : str)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export class HUD {
  constructor() {
    this.app = $('app');
    this.crosshair = $('crosshair');
    this.hud = $('hud');
    this.vignette = $('vignette');

    this.hpFill = $('hp-fill');
    this.hpGhost = $('hp-ghost');
    this.hpText = $('hp-text');
    this.waveEl = $('wave');
    this.leftEl = $('left');
    this.killsEl = $('kills');
    this.scoreEl = $('score');
    this.chipsEl = $('chips');
    this.reloadFill = $('reload-fill');
    this.msg = $('center-msg');

    this.overlay = $('overlay');
    this.bestBox = $('best');
    this.bestText = $('best-text');

    this.reward = $('reward');
    this.rewardWave = $('reward-wave');
    this.rewardTitle = $('reward-title');
    this.rewardSub = $('reward-sub');
    this.cards = $('cards');

    this.weaponIcon = $('weapon-icon');
    this.weaponName = $('weapon-name');
    this.weaponTag = $('weapon-tag');
    this.heatRow = $('heat-row');
    this.heatFill = $('heat-fill');

    this.bossBar = $('boss-bar');
    this.bossName = $('boss-name');
    this.bossHpText = $('boss-hp-text');
    this.bossFill = $('boss-fill');
    this._bossKind = null;

    this.modifierEl = $('modifier');
    this.terrainEl = $('terrain-chip');
    this.terrainDot = $('terrain-dot');
    this.terrainName = $('terrain-name');
    this.terrainSpeed = $('terrain-speed');
    this._terrainKey = '';

    this.gameover = $('gameover');
    this.goNote = $('go-note');
    this.finalWave = $('final-wave');
    this.finalKills = $('final-kills');
    this.finalScore = $('final-score');
    this.finalTime = $('final-time');
    this.newRecord = $('new-record');
    this.bestLine = $('best-line');
    this.lb = $('lb');
    this.lbList = $('lb-list');
    this.lbTitle = $('lb-title');

    // 呼号
    this.callsignEl = $('callsign');
    if (this.callsignEl) this.callsignEl.value = loadCallsign();
    this.callsignErr = $('callsign-err');

    // 排行榜面板
    this.lbPanel = $('lb-panel');
    this.lbBody = $('lb-body');
    this.lbSub = $('lb-sub');
    this.lbSource = $('lb-source');
    this.lbMe = $('lb-me');
    this.shareBox = $('share-box');
    this.shareCodeEl = $('share-code');
    this.shareBtn = $('share-btn');
    this.shareTip = $('share-tip');

    // ---- 组队 ----
    this.lobby = $('lobby');
    this.lobbyChoose = $('lobby-choose');
    this.lobbyWait = $('lobby-wait');
    this.lobbyErr = $('lobby-err');
    this.lobbyStatus = $('lobby-status');
    this.lobbyStart = $('lobby-start');
    this.roomCodeInput = $('room-code');
    this.roomCodeShow = $('room-code-show');
    this.roomPlayers = $('room-players');
    this.lbTabButtons = Array.from(document.querySelectorAll('.lb-tab[data-view]'));
    this.lbModeButtons = Array.from(document.querySelectorAll('.lb-mode[data-mode]'));
    this._lbView = 'day';
    this._lbMode = 'daily';   // daily | normal
    this._lbDate = '';
    this._lbAll = [];
    this._lbDays = [];
    // 邀请链接带来的房间码（由 Game 从 ?room= 解析后挂上来）
    this.inviteRoom = '';
    this.roomCode = '';
    // 服务端下发的自动开局剩余秒数（0 = 没在倒计时）
    this._autoStartLeft = 0;

    this.msgTimer = 0;
    this._pickHandler = null;
    this._weaponHandler = null;
    this._panelKind = 'upgrade';

    // 车体选择
    this.chassisEl = $('chassis-cards');
    this.selectedChassis = 'panther';
    this.renderChassis();

    // 作战模式：solo / coop / campaign（campaign 还没实装，卡片是 disabled）
    this.mode = 'solo';
    this.modeEl = $('mode-cards');
    this.startBtn = $('start-btn');

    // 右下角操作说明
    this.keyHelp = $('key-help');
    // 1280×720 这类笔记本是主力尺寸，展开后 203px 高也压不到面板（横向根本不重叠），
    // 所以门槛压到 700：只有真的很矮的窗口才默认收起。
    const khSmall = window.innerWidth < 900 || window.innerHeight < 700;
    this.keyHelp?.classList.toggle('collapsed', khSmall);
    $('key-help-head')?.addEventListener('click', () => {
      this.keyHelp?.classList.toggle('collapsed');
    });
  }

  /**
   * 渲染开始菜单的车体选择卡（数字键或点击）。现在只有豹式一张。
   *
   * 一行四张、每张约 120px。所以名称必须用简称：写全「轻装突击型」是 5 个字 × 12.5px = 63px，
   * 加上内边距就顶到边了，再长一点（比如以后加「型」字更长的名字）就会折行把整排撑高。
   * 全名和一句话介绍放在 title 里，鼠标悬停能看到。
   */
  renderChassis() {
    if (!this.chassisEl) return;
    this.chassisEl.innerHTML = '';
    // 只剩一款车时把网格切成单列居中（见 styles.css 的 .chassis-cards.single），
    // 否则四列网格里放一张卡，右边会空三大块，看起来像三张没加载出来。
    this.chassisEl.classList.toggle('single', CHASSIS_LIST.length === 1);
    CHASSIS_LIST.forEach((c, i) => {
      const spd = Number.isInteger(c.speed) ? c.speed : c.speed.toFixed(1);
      const btn = document.createElement('button');
      btn.className = 'chassis-card' + (c.id === this.selectedChassis ? ' sel' : '');
      btn.dataset.id = c.id;
      btn.title = `${c.name}：${c.desc}`;
      btn.innerHTML = `
        <span class="chassis-key">${i + 1}</span>
        <span class="chassis-icon">${c.icon}</span>
        <b>${c.short || c.name}</b>
        <i><span>${c.hp} 甲</span><span>${spd} 速</span></i>
        <em>${c.perkText || '—'}</em>
      `;
      // 只有一款车时它不再是"选项"，而是一条身份说明。
      // 一行里塞「🐆 豹式 · 120 甲 · 15 速 · 全向炮塔」在 280px 宽下会挤爆
      // （实测每段被压到 46px、文字折成三行），所以只留名称 + 定位标语，
      // 数值放进 title 悬停查看。
      // 不用 emoji 图标：部分环境（无 emoji 字体的 Windows Server、
      // 精简版 Linux、部分安卓 WebView）会渲染成方块，看着像坏图。
      if (CHASSIS_LIST.length === 1) {
        btn.innerHTML = `<b>${c.short || c.name}</b>`
          + `<em>基础型</em>`
          + `<i><span>${c.hp} 甲</span><span>${c.perkText || '全向炮塔'}</span></i>`;
      }
      btn.addEventListener('click', () => this.selectChassis(i));
      this.chassisEl.appendChild(btn);
    });
  }

  selectChassis(index) {
    const c = CHASSIS_LIST[index];
    if (!c) return;
    this.selectedChassis = c.id;
    for (const el of this.chassisEl.children) {
      el.classList.toggle('sel', el.dataset.id === c.id);
    }
  }

  /**
   * 切换作战模式，主按钮文案跟着变。
   *
   * 为什么不点卡片就出发：呼号是必填项，点卡直接走会在没填呼号时弹错，
   * 玩家的注意力被拉到输入框、刚才点的哪个模式反而忘了。
   * 让三个卡片都是"选项"、按钮是"确认"，语义一致，也只有一条出错路径。
   */
  selectMode(mode) {
    if (mode !== 'solo' && mode !== 'coop') return;
    this.mode = mode;
    for (const el of this.modeEl.children) {
      el.classList.toggle('sel', el.dataset.mode === mode);
    }
    // 按钮文案跟着变就够了，不额外挂 class：
    // 组队是"创建房间"、单人也是立刻开打，都是当前选择的主行动，
    // 视觉上不该有主次之分（以前分成两个按钮时才需要）。
    if (this.startBtn) {
      this.startBtn.textContent = mode === 'coop' ? '组建队伍' : '单人出击';
    }
  }

  /** 呼号校验提示 */
  setCallsignError(msg) {
    if (!this.callsignErr) return;
    this.callsignErr.textContent = msg || '';
    this.callsignErr.classList.toggle('hidden', !msg);
  }

  // ---------------- 首页右上角排行榜卡 ----------------
  //
  // 设计稿里这块是"看一眼就知道谁在榜上"的展示位，不是完整榜单页。
  // 所以只放前 10 条（176×385 扣掉标题条和"你的名次"只剩这么多），
  // 想看全量、切换今日/总榜的完整功能仍然在点「排行榜」弹出的 #lb-panel 里。
  // 数据源完全复用 daily.js，不额外发请求：两个 tab 首次点击才拉，拉过就缓存。

  /** 绑定首页排行榜卡的 tab 与初次渲染 */
  initMenuBoard() {
    this.mbBody = $('mb-body');
    this.mbMineRank = $('mb-mine-rank');
    this.mbMineTotal = $('mb-mine-total');
    this.mbTabs = Array.from(document.querySelectorAll('.mb-tab[data-board]'));
    if (!this.mbBody) return;
    this._mbView = 'day';
    this._mbCache = {};       // { day: [...], all: [...] }
    for (const btn of this.mbTabs) {
      btn.addEventListener('click', () => {
        const v = btn.dataset.board;
        if (v === this._mbView) return;
        this._mbView = v;
        for (const b of this.mbTabs) b.classList.toggle('sel', b.dataset.board === v);
        this.renderMenuBoard();
      });
    }
    this.renderMenuBoard();
  }

  /** 刷新首页排行榜卡（未缓存时拉数据） */
  async renderMenuBoard() {
    if (!this.mbBody) return;
    const view = this._mbView || 'day';
    let list = this._mbCache[view];
    if (!list) {
      try {
        if (view === 'day') {
          const { list: l } = await fetchDay(todayKey());
          list = l || [];
        } else {
          const { all } = await fetchAll();
          list = all || [];
        }
      } catch {
        list = [];
      }
      this._mbCache[view] = list;
    }
    // tab 可能在 await 期间被切走了，以最新选择为准
    if ((this._mbView || 'day') !== view) return;

    this.mbBody.innerHTML = '';
    if (!list.length) {
      this.mbBody.innerHTML = '<li class="mb-empty">暂无记录</li>';
      if (this.mbMineRank) this.mbMineRank.textContent = '—';
      if (this.mbMineTotal) this.mbMineTotal.innerHTML = '<i>0</i> 人上榜';
      return;
    }

    const myPid = getPid();
    const myName = (loadCallsign() || '').trim();
    const myIdx = list.findIndex((e) => HUD.isMe(e, myPid, myName));
    const TOP = 10;

    // 行内元素按设计稿排：名次 / 昵称 / 分数 / 第N波 / N杀 / 时长
    // 设计稿的元信息顺序是「第7波 · 67杀 · 6:11」，时长在最右，
    // 用三个时间加粗的 8px 小字排一行。
    for (const [i, e] of list.slice(0, TOP).entries()) {
      const li = document.createElement('li');
      li.className = 'mb-row';
      // 存档里字段名是 timeMs（见 daily.js 的记录结构），单位毫秒
      const ms = Number(e.timeMs || e.time || 0);
      const secs = Math.max(0, Math.round(ms / 1000));
      const mmss = secs > 0 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : '';
      li.innerHTML = `<span class="r">${i + 1}</span>`
        + `<span class="n">${esc(e.name)}</span>`
        + `<span class="s">${(e.score || 0).toLocaleString()}</span>`
        + `<span class="m">`
        + `<span>第${e.wave || 1}波</span>`
        + `<span>${e.kills || 0}杀</span>`
        + (mmss ? `<span>${mmss}</span>` : '')
        + `</span>`;
      this.mbBody.appendChild(li);
    }

    if (this.mbMineRank) {
      // 设计稿"你的名次"后面跟的是一个数字（1），不是"第 N 名"。
      // 标签已经写了"你的名次"，再加"第""名"是冗余。
      this.mbMineRank.textContent = myIdx >= 0 ? String(myIdx + 1) : '—';
    }
    if (this.mbMineTotal) {
      // 设计稿是「20 人上榜」，数字在前、词在后，数字用 #f6e4bd 高亮
      this.mbMineTotal.innerHTML = `<i>${list.length}</i> 人上榜`;
    }
  }

  /** 打完一局后让首页卡片失效，下次回来重新拉 */
  invalidateMenuBoard() {
    this._mbCache = {};
    this.renderMenuBoard();
  }

  // ---------------- 排行榜面板 ----------------

  /** 打开排行榜：今日 / 总榜 */
  async openLeaderboard() {
    if (!this.lbPanel) return;
    this.lbPanel.classList.remove('hidden');
    this._lbView = 'day';
    this.lbTabButtons?.forEach((b) => b.classList.toggle('sel', b.dataset.view === 'day'));
    this.lbBody.innerHTML = '<li class="lb-empty">读取中…</li>';
    await this.renderDayBoard();
  }

  closeLeaderboard() {
    this.lbPanel?.classList.add('hidden');
  }

  async renderDayBoard() {
    this.lbSub.textContent = `${todayKey()} · 今日`;
    const { list, remote } = await fetchDay(todayKey());
    this.lbSource.textContent = remote ? '全服' : '本机（云端不可用）';
    this.renderBoardList(list || [], '今日榜');
  }

  async renderAllBoard() {
    this.lbSub.textContent = '全部历史';
    const { all, remote } = await fetchAll();
    this.lbSource.textContent = remote ? '全服' : '本机（云端不可用）';
    this.renderBoardList(all || [], '总榜');
  }

  /** 判断某条成绩是不是自己：优先 pid，兼容没有 pid 的旧数据 */
  static isMe(e, myPid, myName) {
    if (!e) return false;
    if (myPid && (e.pid === myPid || (typeof e.id === 'string' && e.id.endsWith(`#${myPid}`)))) return true;
    return !!(myName && e.name === myName);
  }

  renderBoardList(list, title = '') {
    this.lbBody.innerHTML = '';
    const myPid = getPid();
    const myName = (loadCallsign() || '').trim();

    if (!list || list.length === 0) {
      this.lbBody.innerHTML = `<li class="lb-empty">${title}暂无记录</li>`;
      this.lbMe?.classList.add('hidden');
      return;
    }

    const myIdx = list.findIndex((e) => HUD.isMe(e, myPid, myName));

    list.slice(0, 20).forEach((e, i) => {
      const li = document.createElement('li');
      if (HUD.isMe(e, myPid, myName)) li.className = 'me';
      // 老排行榜记录里可能是 balanced/light/heavy/hunter，直接查 CHASSIS 会得到
      // undefined，徽章变成"?"、名字消失。统一走归一化，历史 id 也显示豹式。
      const cid = e.chassis ? normalizeChassisId(e.chassis) : '';
      const c = cid ? CHASSIS[cid] : null;
      const badge = c ? `<span class="chd c-${cid}">${c.name.slice(0, 1)}</span>` : '';
      const t = e.timeMs ? ` · ${fmtTime(e.timeMs)}` : '';
      // 只有多人局才标人数：单人占了绝大多数，逐条写"单人"只是噪音
      const team = (e.players || 1) > 1 ? `<span class="lb-team">${e.players} 人</span>` : '';
      li.innerHTML = `<i>${i + 1}</i><b>${badge}${esc(e.name)}${team}</b>`
        + `<span>第 ${e.wave} 波<small>${e.kills || 0} 杀${t}</small></span>`
        + `<em>${(e.score || 0).toLocaleString()}</em>`;
      this.lbBody.appendChild(li);
    });

    // 我的名次：前 20 之外也给个交代，避免"我明明打了却没有我"
    if (!this.lbMe) return;
    this.lbMe.classList.remove('hidden');
    if (myIdx >= 0) {
      this.lbMe.classList.remove('miss');
      this.lbMe.innerHTML = `<span>你的名次 <b>第 ${myIdx + 1} 名</b></span>`
        + `<span>共 ${list.length} 人上榜</span>`;
    } else {
      this.lbMe.classList.add('miss');
      this.lbMe.innerHTML = `<span>${title}里没有你</span>`
        + `<span>共 ${list.length} 人上榜${list.length >= 100 ? '（仅显示前 100）' : ''}</span>`;
    }
  }

  // ---------------- 组队大厅 ----------------

  /**
   * 打开组队大厅。
   * 大厅本身不碰网络，网络交给外部传入的 net 对象（这里只负责界面）。
   */
  openLobby({ name, chassis, onStart }) {
    if (!this.lobby) return;
    this._lobbyCtx = { name, chassis };
    this._lobbyStart = onStart;
    this._roomShown = '';
    this.lobby.classList.remove('hidden');
    this.lobbyChoose.classList.remove('hidden');
    this.lobbyWait.classList.add('hidden');
    this.setLobbyError('');
    // 邀请链接带来的房间码：直接填好，朋友少输四个字符
    const pre = this.inviteRoom || '';
    $('room-code').value = pre;
    $('room-code').focus();
  }

  closeLobby() {
    this.lobby?.classList.add('hidden');
  }

  setLobbyError(msg) {
    if (!this.lobbyErr) return;
    this.lobbyErr.textContent = msg || '';
    this.lobbyErr.classList.toggle('hidden', !msg);
  }

  /** 进入房间后的界面（等待 / 已在局内都复用） */
  showRoom(code, players = [], myId, started, hostId, statusText) {
    this.lobbyChoose.classList.add('hidden');
    this.lobbyWait.classList.remove('hidden');
    // 只有 4 位真房间码才更新显示。
    // 连接握手期间服务端会先推一次 roster，这时客户端还没拿到 code，
    // 早期版本在这里无条件赋值，结果房间码被瞬间刷成 '——' 并且再也回不来。
    if (/^[A-Z0-9]{4}$/.test(String(code || ''))) this.roomCodeShow.textContent = code;

    this.roomPlayers.innerHTML = '';
    const max = 4;
    for (let i = 0; i < max; i++) {
      const p = players[i];
      const li = document.createElement('li');
      if (!p) {
        li.className = 'empty';
        li.textContent = '等待队友…';
      } else {
        if (p.id === myId) li.className = 'me';
        const c = CHASSIS[normalizeChassisId(p.chassis)];
        const crown = hostId && p.id === hostId ? '<span class="room-host" title="房主">房主</span>' : '';
        li.innerHTML = `<span class="chd c-${normalizeChassisId(p.chassis)}">${(c ? c.name : '?').slice(0, 1)}</span>`
          + `<b>${esc(p.name)}</b>${crown}<span class="room-tag">${c ? c.name : ''}</span>`;
      }
      this.roomPlayers.appendChild(li);
    }

    const isHost = !hostId || hostId === myId;
    if (this.lobbyStatus) {
      // 文案跟着服务端的真实倒计时走（见 Game 里 roster/status 的下发）。
      // 服务端在**有人加入**时重置 3 秒倒计时，到点自动开局；
      // 所以"3 秒后自动开始"是准确的，前提是页面确实收到了 autoStart 剩余时间。
      // 拿不到剩余时间时（老服务端 / 刚连上）退回中性说法，别让人干等。
      const cd = this._autoStartLeft;
      this.lobbyStatus.textContent = statusText
        || (started
          ? '战斗进行中'
          : isHost
            ? (cd > 0
              ? `${players.length}/4 人 · ${Math.ceil(cd)} 秒后自动开始（也可以按「开始战斗」）`
              : `${players.length}/4 人 · 按「开始战斗」出击，也可以继续等人加入`)
            : (cd > 0
              ? `${players.length}/4 人 · ${Math.ceil(cd)} 秒后自动开始`
              : `${players.length}/4 人 · 等房主按「开始战斗」`));
    }
    if (this.lobbyStart) {
      this.lobbyStart.disabled = started || !!statusText;
      this.lobbyStart.textContent = isHost ? '开始战斗' : '等房主开局';
    }
  }

  /** 战斗中的房间浮层：房间码 + 人数，方便喊朋友进来 */
  showRoomChip(code, count) {
    if (!this.roomChip) {
      const el = document.createElement('div');
      el.id = 'room-chip';
      el.className = 'room-chip';
      (this.hud || this.app)?.appendChild(el);
      this.roomChip = el;
    }
    this.roomChip.innerHTML = `<span>房间</span><b>${esc(code)}</b><i>${count}/4</i><em>${esc(BUILD)}</em>`;
    this.roomChip.classList.remove('hidden');
  }

  /** 房间没了（被回收 / 主动离开）：把浮层收掉，别再显示一个已经失效的码 */
  hideRoomChip() {
    this.roomChip?.classList.add('hidden');
  }

  hideRoomChip() {
    this.roomChip?.classList.add('hidden');
  }

  hideLobby() {
    this.lobby?.classList.add('hidden');
  }

  bind({ onStart, onRestart, onPick, onWeapon, onCoop }) {
    this.initMenuBoard();

    // 开局强制填写呼号：空值就地提示，不弹窗打断
    const ensureName = () => {
      const name = (this.callsignEl?.value || '').trim();
      if (name) {
        saveCallsign(name);
        this.setCallsignError('');
        return name;
      }
      this.setCallsignError('先填一个呼号再出击');
      this.callsignEl?.focus();
      this.callsignEl?.classList.add('shake');
      setTimeout(() => this.callsignEl?.classList.remove('shake'), 420);
      return null;
    };

    // ---- 组队入口：先接网络回调，再开大厅 ----
    // 顺序不能反：早期版本是"先开大厅、再补回调"，点「创建房间」时 onCoop 还是 undefined，
    // 表现就是没反应。这里抽成函数，模式卡和主按钮都走同一条路径。
    const enterCoop = () => {
      const name = ensureName();
      if (!name) return;
      const nameSnapshot = name;
      const chassisSnapshot = this.selectedChassis;
      onCoop?.(chassisSnapshot, { name: nameSnapshot });
      this.openLobby({
        name,
        chassis: chassisSnapshot,
        onStart: () => onCoop?.(chassisSnapshot, { name: nameSnapshot }),
      });
    };

    this.modeEl?.querySelectorAll('.mode-card').forEach((btn) => {
      btn.addEventListener('click', () => {
        // disabled 的卡片浏览器本来就不派发 click，但 .off 只是视觉+样式约定，
        // 用 pointer-events 之外还留一道守卫，防止以后改样式时漏掉
        if (btn.disabled || btn.classList.contains('off')) return;
        this.selectMode(btn.dataset.mode);
      });
    });

    this.startBtn?.addEventListener('click', () => {
      if (this.mode === 'coop') { enterCoop(); return; }
      const name = ensureName();
      if (name) onStart(this.selectedChassis, { name });
    });
    if (this.callsignEl) {
      this.callsignEl.addEventListener('change', () => {
        const v = this.callsignEl.value.trim();
        if (v) { saveCallsign(v); this.setCallsignError(''); }
      });
      this.callsignEl.addEventListener('input', () => {
        if (this.callsignEl.value.trim()) this.setCallsignError('');
      });
      // 呼号框里按 Enter 直接出击（走和按钮完全一致的校验流程）
      this.callsignEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          $('start-btn')?.click();
        }
      });
    }
    // ---- 大厅按钮 ----
    $('lobby-close')?.addEventListener('click', () => {
      // 只关面板不关连接：服务端还留着你的席位，点「开始战斗」能回来
      this.closeLobby();
    });
    $('room-code')?.addEventListener('input', (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 4);
      this.setLobbyError('');
    });
    $('room-code')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('lobby-join-btn')?.click();
    });
    $('lobby-create')?.addEventListener('click', () => {
      this.setLobbyError('');
      // 输入框填了码就按用户填的码建房（以前创建完全无视输入框，
      // 用户以为自己定的码生效了，朋友按那个码加入只会收到"房间不存在"）；
      // 没填就随机生成。1 位数字这种不合法的直接拦在大厅里，别等服务器踢回来。
      const code = ($('room-code').value || '').trim().toUpperCase();
      if (code) {
        if (code.length !== 4) {
          this.setLobbyError('自定义房间码要 4 位字母或数字（0/O/1/I 容易看错，别用）');
          return;
        }
        this._netAction?.(code, true);
        return;
      }
      this._netAction?.(null);
    });
    $('lobby-join-btn')?.addEventListener('click', () => {
      const code = ($('room-code').value || '').trim().toUpperCase();
      if (code.length !== 4) {
        this.setLobbyError('房间码是 4 位字母或数字');
        return;
      }
      this.setLobbyError('');
      this._netAction?.(code);
    });
    $('lobby-start')?.addEventListener('click', () => this._netStart?.());
    $('lobby-leave')?.addEventListener('click', () => {
      this._netLeave?.();
      this.closeLobby();
    });
    // 战斗中把大厅收起来：席位还在，点左下角的房间浮层可以再打开
    $('lobby-fold')?.addEventListener('click', () => this.closeLobby());
    document.addEventListener('click', (e) => {
      // 浮层的重开逻辑由 Game 注入（_reopenLobby），没有就直接忽略
      if (!e.target.closest('#room-chip')) return;
      if (typeof this._reopenLobby === 'function') this._reopenLobby();
    }, true);
    $('room-copy')?.addEventListener('click', async () => {
      const code = this.roomCodeShow?.textContent || '';
      const ok2 = await copyText(code);
      $('room-copy').textContent = ok2 ? '已复制' : '复制失败';
      setTimeout(() => { $('room-copy').textContent = '复制'; }, 1600);
    });

    $('lb-open')?.addEventListener('click', () => this.openLeaderboard());
    $('lb-close')?.addEventListener('click', () => this.closeLeaderboard());
    this.lbTabButtons.forEach((btn) => {
      btn.addEventListener('click', async () => {
        this.lbTabButtons.forEach((b) => b.classList.toggle('sel', b === btn));
        if (btn.dataset.view === 'all') await this.renderAllBoard();
        else await this.renderDayBoard();
      });
    });

    // ---- 结算页：邀请好友 ----
    this.shareBtn?.addEventListener('click', async () => {
      const url = this._inviteLink;
      if (!url) return;
      const text = this._lastRoom
        ? `来《钢铁突击》跟我一起打，房间码 ${this._lastRoom}（最多 4 人）：${url}`
        : `来《钢铁突击》跟我一起打，最多 4 人合作：${url}`;
      const done = await copyText(text);
      const old = this.shareBtn.textContent;
      this.shareBtn.textContent = done ? '已复制，发给他吧' : '复制失败，请手动复制';
      setTimeout(() => { this.shareBtn.textContent = old; }, 2000);
    });

    $('again-btn').addEventListener('click', onRestart);
    this._pickHandler = onPick;
    this._weaponHandler = onWeapon;
    this.cards.addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      if (this._panelKind === 'weapon') {
        if (this._weaponHandler) this._weaponHandler(card.dataset.id);
      } else if (this._pickHandler) {
        this._pickHandler(card.dataset.id);
      }
    });
  }

  // ---------------- 场景切换 ----------------
  startPlaying() {
    this.overlay.classList.add('hidden');
    this.reward.classList.add('hidden');
    this.gameover.classList.add('hidden');
    this.hud.classList.remove('hidden');
    this.crosshair.classList.remove('hidden');
    this.app.classList.add('playing');
  }

  showRewards(wave, choices, counts) {
    this._panelKind = 'upgrade';
    this.rewardWave.textContent = String(wave);
    this.rewardTitle.textContent = '选择强化';
    this.rewardSub.textContent = '本波已清除，装甲已修复 6 点';
    this.cards.innerHTML = '';

    choices.forEach((u, i) => {
      const level = counts[u.id] || 0;
      const rarity = RARITY[u.rarity] || RARITY.common;
      const card = document.createElement('button');
      card.className = 'card';
      card.dataset.id = u.id;
      card.style.setProperty('--rarity', rarity.color);
      card.innerHTML = `
        <span class="card-rarity">${u.armory ? '军械' : rarity.label}</span>
        <span class="card-key">${i + 1}</span>
        <div class="card-icon">${u.icon}</div>
        <div class="card-name">${u.name}</div>
        <div class="card-desc">${u.desc}</div>
        <div class="card-lv">${u.armory ? 'NEW · 更换主炮' : `${level === 0 ? 'NEW' : `Lv.${level}`} → Lv.${level + 1} / ${u.max === 99 ? '∞' : u.max}`}</div>
      `;
      this.cards.appendChild(card);
    });

    this.reward.classList.remove('hidden');
    this.app.classList.remove('playing');
  }

  /** 军械面板：wares 为可选武器定义 */
  showArmory(wave, wares, currentId) {
    this._panelKind = 'weapon';
    this.rewardWave.textContent = String(wave);
    this.rewardTitle.textContent = '军械补给';
    this.rewardSub.textContent = '选择一门主炮。已解锁的武器可以在战斗中按 Q 切换';
    this.cards.innerHTML = '';

    wares.forEach((w, i) => {
      const card = document.createElement('button');
      card.className = 'card';
      card.dataset.id = w.id;
      card.style.setProperty('--rarity', w.uiColor || '#ffcf8a');
      card.innerHTML = `
        <span class="card-rarity">武器</span>
        <span class="card-key">${i + 1}</span>
        <div class="card-icon">${w.icon}</div>
        <div class="card-name">${w.name}</div>
        <div class="card-desc">${w.desc}</div>
        <div class="card-lv">${w.tag}${w.id === currentId ? ' · 当前装备' : ' · 点击装备'}</div>
      `;
      this.cards.appendChild(card);
    });

    this.reward.classList.remove('hidden');
    this.app.classList.remove('playing');
  }

  /** 换掉奖励面板的副标题（联机时用来显示"各自选卡 · 12 秒后自动选择"） */
  setRewardSub(text) {
    if (this.rewardSub) this.rewardSub.textContent = text;
  }

  hideRewards() {
    this.reward.classList.add('hidden');
    this.app.classList.add('playing');
  }

  showGameOver({ wave, kills, score, time, best, isNew, mode, ranked, synced, syncReason, myName, leaderboard, overall, teamSize, teamScore }) {
    this.finalWave.textContent = String(wave);
    this.finalKills.textContent = String(kills);
    this.finalScore.textContent = String(score);
    this.finalTime.textContent = time;
    this.newRecord.classList.toggle('hidden', !isNew);
    // 组队不记录个人最佳，此时 best 传 null：整行隐藏，别显示"第 0 波 · 0 分"
    const bestWrap = this.bestLine?.parentElement;
    if (best && (best.wave || best.score)) {
      this.bestLine.textContent = `第 ${best.wave || 0} 波 · ${best.score || 0} 分`;
      bestWrap?.classList.remove('hidden');
    } else {
      bestWrap?.classList.add('hidden');
    }

    // 说清楚成绩去哪了：上没上榜、云端有没有同步成功
    if (this.goNote) {
      let note;
      const modeText = mode === 'coop' ? `${teamSize || 1} 人合作` : '单人';
      const teamText = mode === 'coop' && teamScore > 0 ? ` · 队伍合计 ${Number(teamScore).toLocaleString()} 分` : '';
      // ranked === false：这类局根本不参与排名（目前只有组队）。
      // 必须排在 synced 判断前面 —— 否则会显示成"云端同步失败"，玩家以为丢分了。
      if (ranked === false) {
        note = `${modeText}${teamText} · 组队局不计入榜单，成绩仅本局可见`;
      } else if (syncReason === 'no-score') {
        // 0 分不是"同步失败"，也不会进补传队列 —— 别说成失败，玩家会以为丢分了
        note = `${modeText} · 0 分不计入榜单，再打一局就能上榜`;
      } else if (synced === false) {
        const why = syncReason === 'offline' ? '网络不可用'
          : syncReason === 'storage' ? '服务端存储异常'
          : syncReason === 'stale-date' ? '日期校验未通过'
          : syncReason ? `服务端返回 ${syncReason}` : '未知原因';
        note = `${modeText}成绩已存本机，云端同步失败（${why}）· 下次进入游戏会自动补传`;
      } else {
        note = `已上传全服 · ${modeText}${teamText} · 计入今日榜与总榜`;
      }
      this.goNote.textContent = note;
      this.goNote.classList.toggle('hidden', !note);
      this.goNote.classList.toggle('warn', synced === false);
    }

    // 邀请好友：带上房间码，朋友打开就自动填好
    const inviteLink = buildInviteLink(this._lastRoom || this.inviteRoom || '');
    this._inviteLink = inviteLink;
    this.shareBox?.classList.toggle('hidden', !inviteLink);
    if (this.shareCodeEl && inviteLink) {
      this.shareCodeEl.textContent = this._lastRoom || location.host;
    }
    if (this.shareTip) {
      this.shareTip.textContent = this._lastRoom
        ? `把链接发给朋友，他打开就会自动带上房间码 ${this._lastRoom}（最多 4 人）`
        : '把链接发给朋友，一起组队打（最多 4 人）';
    }
    if (this.shareBtn) {
      this.shareBtn.classList.remove('hidden');
      this.shareBtn.textContent = this._lastRoom ? '复制邀请链接' : '复制游戏链接';
    }

    // 今日 Top5 + 历史总榜
    if (this.lb && this.lbList && this.lbTitle) {
      const hasDay = Array.isArray(leaderboard) && leaderboard.length > 0;
      const hasAll = Array.isArray(overall) && overall.length > 0;
      this.lb.classList.toggle('hidden', !(hasDay || hasAll));
      this.lbList.innerHTML = '';
      if (hasDay || hasAll) {
        this.lbTitle.textContent = '今日排行榜';
        const render = (list, label) => {
          if (!list || !list.length) return;
          const head = document.createElement('li');
          head.className = 'lb-group';
          head.textContent = label;
          this.lbList.appendChild(head);
          list.slice(0, 5).forEach((e, i) => {
            const li = document.createElement('li');
            if (HUD.isMe(e, getPid(), myName)) li.className = 'me';
            li.innerHTML = `<i>${i + 1}</i><b>${esc(e.name)}</b><span>第 ${e.wave} 波</span><em>${(e.score || 0).toLocaleString()}</em>`;
            this.lbList.appendChild(li);
          });
        };
        render(leaderboard, '今日');
        render(overall, '历史总榜');
      }
    }

    this.gameover.classList.remove('hidden');
    this.hud.classList.add('hidden');
    this.crosshair.classList.add('hidden');
    this.app.classList.remove('playing');
  }

  setBest(best) {
    if (best && best.wave > 0) {
      this.bestBox.classList.remove('hidden');
      this.bestText.textContent = `第 ${best.wave} 波 · ${best.score} 分`;
    } else {
      this.bestBox.classList.add('hidden');
    }
  }

  // ---------------- HUD 数值 ----------------
  setHealth(hp, maxHp) {
    const ratio = Math.max(0, hp / maxHp);
    this.hpFill.style.width = `${ratio * 100}%`;
    this.hpGhost.style.width = `${ratio * 100}%`;
    this.hpText.textContent = `${Math.max(0, Math.round(hp))} / ${maxHp}`;
    this.hpFill.style.background = ratio > 0.5
      ? 'linear-gradient(90deg,#9bd35a,#ffb03a)'
      : ratio > 0.25
        ? 'linear-gradient(90deg,#ffb03a,#ff7a3a)'
        : 'linear-gradient(90deg,#ff5a3a,#c81e1e)';
  }

  setReload(ratio) {
    this.reloadFill.style.transform = `scaleX(${Math.max(0, Math.min(1, ratio))})`;
  }

  setWeapon(w) {
    this.weaponIcon.textContent = w.icon;
    this.weaponName.textContent = w.name;
    this.weaponTag.textContent = w.tag;
    this.weaponTag.style.color = w.uiColor || 'var(--muted)';
    this.heatRow.classList.toggle('hidden', !w.heat);
  }

  setHeat(ratio, overheated, visible = true) {
    this.heatRow.classList.toggle('hidden', !visible);
    if (!visible) return;
    const v = Math.max(0, Math.min(1, ratio));
    this.heatFill.style.width = `${v * 100}%`;
    this.heatFill.classList.toggle('hot', v > 0.62 && !overheated);
    this.heatFill.classList.toggle('over', !!overheated);
    this.heatRow.classList.toggle('over', !!overheated);
  }

  showBossBar(name, kind, hp, maxHp, enraged) {
    this.bossBar.classList.remove('hidden');
    if (this._bossKind !== kind) {
      this._bossKind = kind;
      this.bossBar.dataset.kind = kind;
      this.bossName.textContent = name;
    }
    this.setBossHealth(hp, maxHp, enraged);
  }

  setBossHealth(hp, maxHp, enraged) {
    const ratio = Math.max(0, Math.min(1, hp / maxHp));
    this.bossFill.style.width = `${ratio * 100}%`;
    this.bossHpText.textContent = `${Math.max(0, Math.ceil(hp))} / ${maxHp}`;
    this.bossBar.classList.toggle('enraged', !!enraged);
  }

  hideBossBar() {
    this.bossBar.classList.add('hidden');
    this._bossKind = null;
  }

  setWave(n) { this.waveEl.textContent = String(n); }

  /**
   * 脚下地表指示。
   *
   * 为什么值得占一块常驻 UI：五种地形的速度差最大到 45%（公路 1.12 / 沼泽 0.55），
   * 玩家在被追的时候只会感觉"今天车怎么这么肉"，而不会想到是自己站进了沼泽。
   * 有个色块 + 百分比，这个信息就变成可操作的（往哪边跑是玩家的决策）。
   *
   * @param {{name:string,color:string,speed:number}} t 地表信息
   */
  setTerrain(t) {
    if (!this.terrainEl) return;
    if (!t) {
      this.terrainEl.classList.add('hidden');
      this._terrainKey = '';
      return;
    }
    // 百分比只显示整数，所以 100 / 101 这种没必要重排 DOM
    const pct = Math.round(t.speed * 100);
    const key = `${t.name}|${pct}`;
    if (key === this._terrainKey) return;
    this._terrainKey = key;

    this.terrainEl.classList.remove('hidden');
    this.terrainName.textContent = t.name;
    this.terrainSpeed.textContent = `${pct}%`;
    this.terrainDot.style.background = t.color;
    this.terrainEl.classList.toggle('slow', pct <= 80);
    this.terrainEl.classList.toggle('fast', pct >= 108);
  }

  /** 顶部显示本局挑战词条 */
  setModifier(mod) {
    if (!this.modifierEl) return;
    if (mod && mod.id) {
      this.modifierEl.textContent = `${mod.icon} ${mod.name} · ${mod.desc}`;
      this.modifierEl.classList.remove('hidden');
    } else {
      this.modifierEl.classList.add('hidden');
    }
  }
  setLeft(n) { this.leftEl.textContent = String(n); }
  setKills(n) { this.killsEl.textContent = String(n); }
  setScore(n) { this.scoreEl.textContent = String(n); }

  /** 用强化定义渲染徽章（图标 + 等级） */
  renderChips(list) {
    this.chipsEl.innerHTML = '';
    for (const { icon, name, level } of list) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.title = `${name} Lv.${level}`;
      chip.innerHTML = `<span>${icon}</span><i>${level}</i>`;
      this.chipsEl.appendChild(chip);
    }
  }

  hurt() {
    this.vignette.classList.add('hit');
    clearTimeout(this._hurtT);
    this._hurtT = setTimeout(() => this.vignette.classList.remove('hit'), 90);
  }

  showMessage(text, seconds = 1.6) {
    this.msg.textContent = text;
    this.msg.classList.add('show');
    this.msgTimer = seconds;
  }

  moveCrosshair(x, y) {
    this.crosshair.style.left = `${x}px`;
    this.crosshair.style.top = `${y}px`;
  }

  update(dt) {
    if (this.msgTimer > 0) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0) this.msg.classList.remove('show');
    }
  }
}
