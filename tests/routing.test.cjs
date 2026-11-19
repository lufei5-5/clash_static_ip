const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'clash-verge-static-ip.js'), 'utf8');
const endpoint = { type: 'http', server: '192.0.2.20', port: 8080, username: 'fixture-user', password: 'fixture-password' };
const base = {
  proxies: [{ name: 'JP-test', type: 'ss' }, { name: 'US-test', type: 'ss' }],
  'proxy-groups': [{ name: 'Default Proxy', type: 'select', proxies: ['JP-test', 'US-test'] }],
  rules: ['DOMAIN-SUFFIX,local.example,DIRECT', 'GEOIP,CN,DIRECT', 'MATCH,Default Proxy'],
  dns: {
    'enhanced-mode': 'fake-ip',
    'fake-ip-filter': ['*.lan'],
    'nameserver-policy': { '+.local.example': 'https://doh.pub/dns-query#DIRECT' },
  },
  tun: { enable: false },
};

function transform(config = base, proxy = endpoint) {
  const sandbox = vm.createContext({ input: structuredClone(config), endpoint: proxy });
  vm.runInContext(script, sandbox);
  if (proxy) vm.runInContext('Object.assign(staticProxy, endpoint)', sandbox);
  return JSON.parse(vm.runInContext('JSON.stringify({ config: main(input), staticGroup, normalGroup, chainPrefix })', sandbox));
}

function route(config, host, network = 'TCP') {
  const matches = (kind, domain) => host === domain || (kind === 'DOMAIN-SUFFIX' && host.endsWith('.' + domain));
  for (const rule of config.rules) {
    const udp = /^AND,\(\(NETWORK,UDP\),\((DOMAIN(?:-SUFFIX)?),([^()]+)\)\),REJECT$/.exec(rule);
    if (udp && network === 'UDP' && matches(udp[1], udp[2])) return 'REJECT';
    const [kind, value, target] = rule.split(',');
    if (['DOMAIN', 'DOMAIN-SUFFIX'].includes(kind) && matches(kind, value)) return target;
    if (kind === 'MATCH') return value;
  }
}

test('静态、YouTube 和订阅规则按预期优先级匹配', () => {
  const { config, staticGroup, normalGroup } = transform();
  for (const host of ['x.com', 'video.twimg.com', 'chatgpt.com', 'claude.ai', 'gemini.google.com', 'ai.meta.com']) {
    assert.equal(route(config, host), staticGroup, host);
  }
  for (const host of ['youtube.com', 'video.googlevideo.com', 'youtubei.googleapis.com', 'yt3.googleusercontent.com']) {
    assert.equal(route(config, host, 'TCP'), normalGroup, host);
    assert.equal(route(config, host, 'UDP'), normalGroup, host);
  }
  assert.equal(route(config, 'x.com', 'UDP'), 'REJECT');
  assert.equal(route(config, 'local.example'), 'DIRECT');
  assert.equal(route(config, 'other.example'), normalGroup);
  assert.equal(route(transform({ ...base, rules: ['MATCH,DIRECT'] }).config, 'other.example'), 'DIRECT');
  assert.equal(route(transform({ proxies: base.proxies }).config, 'other.example'), normalGroup);
});

test('普通组测速订阅节点，静态组测速完整链路，重复加载结果一致', () => {
  const { config, staticGroup, normalGroup, chainPrefix } = transform();
  const groups = new Map(config['proxy-groups'].map(group => [group.name, group]));
  const normal = groups.get(normalGroup);
  const staticAuto = groups.get(staticGroup);
  const names = base.proxies.map(proxy => proxy.name);
  assert.equal(normal.type, 'url-test');
  assert.deepEqual(normal.proxies, names);
  assert.equal(staticAuto.type, 'url-test');
  assert.equal(staticAuto.lazy, false);
  assert.deepEqual(staticAuto.proxies, names.map(name => chainPrefix + name));
  for (const name of names) {
    const chain = config.proxies.find(proxy => proxy.name === chainPrefix + name);
    assert.deepEqual(chain, { ...endpoint, name: chainPrefix + name, 'dialer-proxy': name });
  }
  assert.deepEqual(transform(config).config, config);

  const updated = { ...config, proxies: config.proxies.filter(proxy => proxy.name !== 'US-test') };
  const result = transform(updated, { ...endpoint, type: 'socks5', server: '192.0.2.99' }).config;
  const chains = result.proxies.filter(proxy => proxy.name.startsWith(chainPrefix));
  assert.deepEqual(chains.map(({ name, server, type }) => ({ name, server, type })), [
    { name: chainPrefix + 'JP-test', server: '192.0.2.99', type: 'socks5' },
  ]);
});

test('DNS 随规则选择出口并保留订阅 DNS 例外', () => {
  const { config, staticGroup, normalGroup } = transform();
  const policy = config.dns['nameserver-policy'];
  assert.deepEqual(policy['+.x.com'], [`https://1.1.1.1/dns-query#${staticGroup}`, `https://8.8.8.8/dns-query#${staticGroup}`]);
  assert.equal(policy['+.youtubei.googleapis.com'][0], `https://1.1.1.1/dns-query#${normalGroup}`);
  assert.equal(policy['yt3.googleusercontent.com'][0], `https://1.1.1.1/dns-query#${normalGroup}`);
  assert.deepEqual(policy['+.local.example'], base.dns['nameserver-policy']['+.local.example']);
  assert.deepEqual(config.dns['fake-ip-filter'], base.dns['fake-ip-filter']);
  assert.deepEqual(config.tun, base.tun);
});

test('占位符、无订阅节点和组名冲突均给出错误', () => {
  assert.throws(() => transform(base, null), /请在脚本顶部填写/);
  assert.throws(() => transform({ proxies: [] }), /订阅缺少 proxies/);
  const { staticGroup, chainPrefix } = transform();
  assert.throws(() => transform({ proxies: [{ name: staticGroup }] }), /代理组同名/);
  assert.throws(() => transform({
    ...base, 'proxy-groups': [{ name: chainPrefix + base.proxies[0].name }],
  }), /静态链路同名/);
});
