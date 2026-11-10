// 车体定义：开局选择，决定装甲/移速基础值与车体配色、专属特性。
// 主炮（weapons.js）与车体（本文件）自由组合，强化卡对两者通吃。
//
// 这个文件是车体数值的**唯一来源**。
// 服务端（src/core/world.js）也从这里取，不要再另写一份 CHASSIS_TABLE ——
// 曾经有过两份，改了一个忘了另一个，联机时客户端按 20 预测位移、
// 服务端按 19.5 算权威位置，每帧差一点、每帧被校正拉回，手感就是"拖拽"。
// 本文件没有任何 import，服务端 import 它不会把 three.js 拖进 Node 进程。

// ----------------------------------------------------------------------
// 车体：目前只有一款「豹式」
//
// 曾经有均衡 / 轻装 / 重装 / 猎手四款，但四选一在实战里没有产生有意义的
// 分工（八方向平移 + 全向炮塔之后，机动差异被地形和掩体吃掉了），反而让
// 联机时"我该按哪个键"多了一步。现在统一成一款基础型豹式，数值取原来的
// 均衡型：不偏科，任何玩法都能上手。
//
// 数据结构保持"表"的形状（CHASSIS / CHASSIS_LIST / CHASSIS_TABLE），
// 以后要加车直接往表里添一项即可，UI 和协议都不用改。
//
// 注意倒车：因为车头永远追随移动方向，按 S 时车头会掉过来朝后走，
// 炮口自然也跟着掉过来——"倒车时炮口仍朝车头方向"这句需求在当前
// 八方向移动模型下是自动成立的，不需要额外代码。
//
// ⚠ 射界是相对**车头**的，不是相对世界坐标。车体转向会把炮塔一起带过去，
//   这一步必须是瞬时的（炮塔焊在车体上），否则转个弯炮口会飘出去几十度。
// ----------------------------------------------------------------------

/** 180° = 全向；15° = 受限射界（历史车型用，当前车型是全向） */
export const FULL_TRAVERSE = 180;
export const LIMITED_TRAVERSE = 15;

export const CHASSIS = {
  panther: {
    id: 'panther',
    name: '豹式',
    short: '豹式',
    icon: '🐆',
    tag: '标准',
    desc: '基础型豹式坦克，各项均衡，全向炮塔瞬间对准，任何主炮都能胜任。',
    hp: 120,
    speed: 15,
    turn: 3.0,
    turret: { rate: 0, limit: FULL_TRAVERSE, snap: true },
    colors: { body: 0x8fae5c, accent: 0x53682f, metal: 0x3a4048 },
    perkText: '全向炮塔',
    perks: {},
  },
};

/**
 * 旧 id → 豹式。
 *
 * 老存档 / 老版本客户端 / 老排行榜记录里还带着 balanced/light/heavy/hunter，
 * 直接查表会落空然后退回默认值——能跑，但界面会显示成"?"。
 * 这里显式映射，避免历史数据变成灵异 bug。
 */
export const CHASSIS_ALIAS = {
  balanced: 'panther',
  light: 'panther',
  heavy: 'panther',
  hunter: 'panther',
  commander: 'panther',
};

/** 把任意来源的车体 id 归一到存在的那一款 */
export function normalizeChassisId(id) {
  if (id && CHASSIS[id]) return id;
  const alias = CHASSIS_ALIAS[id];
  if (alias && CHASSIS[alias]) return alias;
  return 'panther';
}

export const CHASSIS_LIST = Object.values(CHASSIS);

const DEG = Math.PI / 180;

/**
 * 「瞬间对准」用的转速（rad/s）。
 *
 * 为什么不写 Infinity：`Infinity * 0` 是 NaN，只要有那么一帧 dt 为 0
 * （rAF 首帧、服务端补帧），炮塔角度就会变成 NaN，然后整辆车在所有
 * 参照系里一起消失。1e6 rad/s ≈ 每秒 5.7 万圈，一帧就转过任何角度，
 * 效果与瞬间对准完全一致，但算术是安全的。
 */
export const TURRET_SNAP_RATE = 1e6;

/**
 * 模拟层要的扁平数值表。
 *
 * 从 CHASSIS 派生，**不是手抄**。手抄两份表就是 bug 温床：
 * 调了车体卡上显示的 20，忘了服务端那份还是 19.5，
 * 于是联机每帧都有 0.5 m/s 的位移差被校正拉回，手感变成拖拽。
 *
 * perks 是给 UI 看的可读描述，这里翻译成纯数字：
 *   damageTakenMul → takenMul（乘在受到的伤害上，0.85 = 少受 15%）
 *   killHeal       → killHeal（每次击杀回多少血）
 *
 * turret 同理：数据层写「度」（策划看得懂），模拟层要「弧度」（三角函数要）。
 * 折算只在这一处发生，两边不可能对不上。
 */
export const CHASSIS_TABLE = Object.fromEntries(
  CHASSIS_LIST.map((c) => {
    const t = c.turret || { rate: 0, limit: FULL_TRAVERSE, snap: true };
    return [
      c.id,
      {
        hp: c.hp,
        speed: c.speed,
        turn: c.turn,
        dmgMul: 1,
        takenMul: c.perks?.damageTakenMul ?? 1,
        killHeal: c.perks?.killHeal ?? 0,
        // 炮塔：rate 为角速度（rad/s），limit 为相对车头的射界半角（rad）
        turretRate: t.snap ? TURRET_SNAP_RATE : t.rate * DEG,
        turretLimit: (t.limit ?? FULL_TRAVERSE) * DEG,
        turretSnap: !!t.snap,
      },
    ];
  }),
);

/** 车体 id → 炮塔参数；未知 id 退回豹式（全向瞬间对准） */
export function turretOf(chassisId) {
  const t = CHASSIS_TABLE[normalizeChassisId(chassisId)];
  return { rate: t.turretRate, limit: t.turretLimit, snap: t.turretSnap };
}
