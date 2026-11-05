import { RARITY } from './upgrades.js';
import { CHASSIS_LIST } from './chassis.js';
import { loadCallsign, saveCallsign } from './daily.js';

const $ = (id) => document.getElementById(id);

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

  bind({ onStart, onDaily, onRestart, onPick, onWeapon }) {
    $('start-btn').addEventListener('click', () => onStart(this.selectedChassis));
    if ($('daily-btn')) {
      $('daily-btn').addEventListener('click', () => onStart(this.selectedChassis, { daily: true }));
    }
    if (this.callsignEl) {
      this.callsignEl.addEventListener('change', () => saveCallsign(this.callsignEl.value.trim()));
    }
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

  showGameOver({ wave, kills, score, time, best, isNew, daily, myName, leaderboard }) {
    this.finalWave.textContent = String(wave);
    this.finalKills.textContent = String(kills);
    this.finalScore.textContent = String(score);
    this.finalTime.textContent = time;
    this.newRecord.classList.toggle('hidden', !isNew);
    this.bestLine.textContent = `第 ${best.wave} 波 · ${best.score} 分`;

    // 每日挑战排行榜
    if (this.lb && this.lbList && this.lbTitle) {
      const show = !!daily && Array.isArray(leaderboard) && leaderboard.length > 0;
      this.lb.classList.toggle('hidden', !show);
      if (show) {
        this.lbTitle.textContent = daily ? '今日排行榜' : '排行榜';
        this.lbList.innerHTML = '';
        leaderboard.forEach((e, i) => {
          const li = document.createElement('li');
          if (myName && e.name === myName) li.className = 'me';
          li.innerHTML = `<i>${i + 1}</i><b>${e.name}</b><span>第 ${e.wave} 波</span><em>${e.score}</em>`;
          this.lbList.appendChild(li);
        });
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
