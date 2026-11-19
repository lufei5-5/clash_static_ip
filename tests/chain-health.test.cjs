const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: pause } = require('node:timers/promises');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const binary = process.env.MIHOMO_TEST_BINARY || '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo';

test('真实内核：前置普通测速成功但静态中转失败时，自动选择另一条完整链路', {
  skip: !fs.existsSync(binary) && '未提供本机 Mihomo；可用 MIHOMO_TEST_BINARY 指定', timeout: 20000,
}, async t => {
  const sockets = new Set();
  const servers = [];
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    for (const server of servers) server.close();
  });
  async function listen(server) {
    servers.push(server);
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
  }
  function proxy(blockPort) {
    const server = http.createServer((req, res) => res.writeHead(204).end());
    server.on('connect', (req, client, head) => {
      const target = new URL('http://' + req.url);
      if (Number(target.port) === blockPort) {
        client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const upstream = net.connect(Number(target.port), target.hostname);
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
    });
    return server;
  }
  const targetPort = await listen(http.createServer((req, res) => res.writeHead(204).end()));
  const staticPort = await listen(proxy());
  const badPort = await listen(proxy(staticPort));
  const goodPort = await listen(proxy());
  // 分配独立本地控制端口，不接触正在运行的 Clash 控制接口、系统代理或 TUN。
  const reservation = net.createServer();
  const apiPort = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const script = fs.readFileSync(path.join(root, 'clash-verge-static-ip.js'), 'utf8');
  const sandbox = vm.createContext();
  vm.runInContext(script, sandbox);
  sandbox.port = staticPort;
  vm.runInContext(`Object.assign(staticProxy, {
    server: '127.0.0.1', port, username: 'test-user', password: 'test-pass',
  });`, sandbox);
  const { staticGroup, chainPrefix } = vm.runInContext('({ staticGroup, chainPrefix })', sandbox);
  sandbox.input = { proxies: [
    { name: 'bad', type: 'http', server: '127.0.0.1', port: badPort },
    { name: 'good', type: 'http', server: '127.0.0.1', port: goodPort },
  ] };
  const config = JSON.parse(JSON.stringify(vm.runInContext('main(input)', sandbox)));
  const url = `http://127.0.0.1:${targetPort}/generate_204`;
  for (const group of config['proxy-groups']) if (group.type === 'url-test') {
    group.url = url;
    group.lazy = false;
    group.timeout = 1000;
  }
  Object.assign(config, {
    'external-controller': `127.0.0.1:${apiPort}`, 'log-level': 'silent',
    dns: { enable: false }, rules: ['MATCH,' + staticGroup],
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'static-ip-chain-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(binary, ['-d', directory, '-f', configPath], { stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  });
  const api = endpoint => fetch(`http://127.0.0.1:${apiPort}${endpoint}`, { signal: AbortSignal.timeout(2000) });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { ready = (await api('/version')).ok; } catch {}
    if (ready || child.exitCode !== null) break;
    await pause(100);
  }
  assert(ready, '独立测试内核未启动');
  const delay = name => api(`/proxies/${encodeURIComponent(name)}/delay?timeout=1000&url=${encodeURIComponent(url)}`);
  assert.equal((await delay('bad')).status, 200, '故障前置仍能通过普通测速');
  assert.equal((await delay(chainPrefix + 'bad')).status, 503, '故障前置的完整静态链路必须失败');
  assert.equal((await delay(chainPrefix + 'good')).status, 200, '另一条完整静态链路可用');
  const group = await (await api('/proxies/' + encodeURIComponent(staticGroup))).json();
  assert.equal(group.now, chainPrefix + 'good', '自动组应避开普通测速正常的故障前置');
  assert.deepEqual(group.all, ['bad', 'good'].map(name => chainPrefix + name));
});
