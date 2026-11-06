import { RARITY } from './upgrades.js';
import { CHASSIS_LIST } from './chassis.js';
import { loadCallsign, saveCallsign, todayKey, fetchAll, fetchDay, getPid } from './daily.js';
import { CHASSIS } from './chassis.js';

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

    this.msgTimer = 0;
    this._pickHandler = null;
    this._weaponHandler = null;
    this._panelKind = 'upgrade';

    // 车体选择
    this.chassisEl = $('chassis-cards');
    this.selectedChassis = 'balanced';
    this.renderChassis();
  }

  /** 渲染开始菜单的车体选择卡（1~4 或点击） */
  renderChassis() {
    if (!this.chassisEl) return;
    this.chassisEl.innerHTML = '';
    CHASSIS_LIST.forEach((c, i) => {
      const perk = c.perks?.damageTakenMul
        ? `受伤 -${Math.round((1 - c.perks.damageTakenMul) * 100)}%`
        : c.perks?.killHeal
          ? `击杀回甲 +${c.perks.killHeal}`
          : '无特性';
      const btn = document.createElement('button');
      btn.className = 'chassis-card' + (c.id === this.selectedChassis ? ' sel' : '');
      btn.dataset.id = c.id;
      btn.innerHTML = `
        <span class="chassis-key">${i + 1}</span>
        <span class="chassis-icon">${c.icon}</span>
        <b>${c.name}</b>
        <i>装甲 ${c.hp} · 移速 ${c.speed}</i>
        <em>${c.tag} · ${perk}</em>
      `;
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

  /** 呼号校验提示 */
  setCallsignError(msg) {
    if (!this.callsignErr) return;
    this.callsignErr.textContent = msg || '';
    this.callsignErr.classList.toggle('hidden', !msg);
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
      const c = e.chassis ? CHASSIS[e.chassis] : null;
      const badge = c ? `<span class="chd c-${e.chassis}">${c.name.slice(0, 1)}</span>` : '';
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
        const c = CHASSIS[p.chassis];
        const crown = hostId && p.id === hostId ? '<span class="room-host" title="房主">房主</span>' : '';
        li.innerHTML = `<span class="chd c-${p.chassis}">${(c ? c.name : '?').slice(0, 1)}</span>`
          + `<b>${esc(p.name)}</b>${crown}<span class="room-tag">${c ? c.name : ''}</span>`;
      }
      this.roomPlayers.appendChild(li);
    }

    const isHost = !hostId || hostId === myId;
    if (this.lobbyStatus) {
      this.lobbyStatus.textContent = statusText
        || (started
          ? '战斗进行中'
          : isHost
            ? `${players.length}/4 人 · 3 秒后自动开始（也可以按「开始战斗」）`
            : `${players.length}/4 人 · 等房主开始（最多 4 人）`);
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
    this.roomChip.innerHTML = `<span>房间</span><b>${esc(code)}</b><i>${count}/4</i>`;
    this.roomChip.classList.remove('hidden');
  }

  hideRoomChip() {
    this.roomChip?.classList.add('hidden');
  }

  hideLobby() {
    this.lobby?.classList.add('hidden');
  }

  bind({ onStart, onRestart, onPick, onWeapon, onCoop }) {
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

    $('start-btn').addEventListener('click', () => {
      const name = ensureName();
      if (name) onStart(this.selectedChassis, { name });
    });
    // ---- 组队：进大厅前也要先有呼号 ----
    $('coop-btn')?.addEventListener('click', () => {
      const name = ensureName();
      if (name) {
        const nameSnapshot = name;
        const chassisSnapshot = this.selectedChassis;
        // 先请求 Game 接好网络回调（openCoop），再打开大厅：
        // 否则会在大厅出现后再补回调，早期的顺序问题正是"点「创建房间」没反应"的根源。
        onCoop?.(chassisSnapshot, { name: nameSnapshot });
        this.openLobby({
          name,
          chassis: chassisSnapshot,
          onStart: () => onCoop?.(chassisSnapshot, { name: nameSnapshot }),
        });
      }
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

  hideRewards() {
    this.reward.classList.add('hidden');
    this.app.classList.add('playing');
  }

  showGameOver({ wave, kills, score, time, best, isNew, mode, synced, syncReason, myName, leaderboard, overall, teamSize, teamScore }) {
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
      if (synced === false) {
        const why = syncReason === 'offline' ? '网络不可用'
          : syncReason === 'kv-unbound' ? '服务端未绑定 KV'
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
