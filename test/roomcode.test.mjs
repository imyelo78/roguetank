// 冒烟测试：自定义房间码建房 / 加入 / 码冲突 / 非法码 / no-room 诊断
// 运行前先起服务： node server.mjs
// 然后： node test/roomcode.test.mjs [port]

import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, C2S, S2C } from '../src/core/protocol.js';

const PORT = Number(process.argv[2] || 5173);
const URL = `ws://127.0.0.1:${PORT}/ws`;

let pass = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name;
    this.msgs = [];
    this.ws = new WebSocket(URL);
  }
  hello(extra = {}) {
    return new Promise((resolve, reject) => {
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ k: C2S.HELLO, v: PROTOCOL_VERSION, name: this.name, chassis: 'heavy', ...extra }));
      });
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw);
        this.msgs.push(m);
        if (m.k === S2C.WELCOME || m.k === S2C.DENY) resolve(m);
      });
      setTimeout(() => reject(new Error('握手超时')), 5000);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const CODE = 'T7XK';

// 1. 自定义码建房
const host = new Client('房主');
let m = await host.hello({ code: CODE, make: 1 });
assert.equal(m.k, S2C.WELCOME, `自定义码建房应成功，实际 ${JSON.stringify(m)}`);
assert.equal(m.code, CODE);
ok(`自定义码 ${CODE} 建房成功`);

// 2. 朋友按码加入
const p2 = new Client('队友');
m = await p2.hello({ code: CODE.toLowerCase() });
assert.equal(m.k, S2C.WELCOME, '按码加入应成功');
assert.equal(m.code, CODE);
ok('朋友按码（小写也能）加入成功');

// 3. 再用同一个码建房 → room-taken
const p3 = new Client('撞码的');
m = await p3.hello({ code: CODE, make: 1 });
assert.equal(m.k, S2C.DENY);
assert.equal(m.reason, 'room-taken', `应报 room-taken，实际 ${m.reason}`);
ok('用被占用的码建房 → 明确提示 room-taken');

// 4. 1 位数字建房 → bad-code（用户报的"输 1 位也能创建"）
const p4 = new Client('手滑的');
m = await p4.hello({ code: '1', make: 1 });
assert.equal(m.k, S2C.DENY);
assert.equal(m.reason, 'bad-code', `应报 bad-code，实际 ${m.reason}`);
ok('1 位数字建房 → 拦下（bad-code），不会再"照常创建"');

// 5. no-room：不存在的码加入
const p5 = new Client('输错码的');
m = await p5.hello({ code: 'QQQQ' });
assert.equal(m.k, S2C.DENY);
assert.equal(m.reason, 'no-room');
ok('不存在的码加入 → no-room');

// 6. 房间列表接口能查到这个房间（前端 deny 时拉它做诊断）
const res = await fetch(`http://127.0.0.1:${PORT}/api/rooms`);
const d = await res.json();
assert.ok(d.ok && String(d.codes).split(' ').includes(CODE), `房间列表应含 ${CODE}，实际 ${d.codes}`);
ok(`/api/rooms 列表里能看到 ${CODE}（join 失败时的诊断数据源）`);

host.close(); p2.close(); p3.close(); p4.close(); p5.close();
await sleep(200);
console.log(`\n房间码冒烟测试全部通过（${pass} 项）`);
process.exit(0);
