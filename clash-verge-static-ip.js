// Clash Verge Rev 全局扩展脚本。复制后只在本机填写自己的静态代理信息。
const staticProxy = {
  type: "http", // 支持 http 或 socks5
  server: "YOUR_PROXY_HOST",
  port: 8080,
  username: "YOUR_PROXY_USERNAME",
  password: "YOUR_PROXY_PASSWORD",
  // tls: true, // HTTP 代理入口要求 TLS 时启用
};

const normalGroup = "🚀 普通自动选择";
const staticGroup = "🔒 静态出口自动选择";
const chainPrefix = "🔗 静态链路 · ";

const staticDomains = [
  "x.com", "twitter.com", "twimg.com", "t.co",
  "twitteroauth.com", "twtrdns.net", "twttr.com", "twttr.net",
  "twvid.com", "openai.com", "chatgpt.com", "oaistatic.com",
  "oaiusercontent.com", "oaistatsig.com", "openaimerge.com", "workos.com",
  "workoscdn.com", "authkit.app", "claude.ai", "anthropic.com",
  "claude.com", "claude.dev", "clau.de", "claudeusercontent.com",
  "claudemcpclient.com", "claudemcpcontent.com", "google.com", "google.com.hk",
  "google.com.sg", "google.co.jp", "google.co.uk", "google.com.tw",
  "googleapis.com", "gstatic.com", "googleusercontent.com", "google.ai",
  "deepmind.com", "deepmind.google", "ai.google", "net.coffee",
  "chat.com", "chatgpt.site", "crixet.com", "sora.com",
  "gemini.google.com", "bard.google.com", "aistudio.google.com", "makersuite.google.com",
  "flow.google.com", "notebook.google", "labstailwind.pa.googleapis.com", "gemini.google",
  "chat.google.com", "ai.studio", "generativeai.google", "generativelanguage.googleapis.com",
  "ai.google.dev", "aiplatform.googleapis.com", "aicode.googleapis.com", "ai.google.com",
  "gemini.gstatic.com", "labs.google.com", "labs.google", "jules.google",
  "jules.google.com", "antigravity.google", "flow.google", "stitch.withgoogle.com",
  "cloud.google.com", "notebooklm.google.com", "notebooklm.google", "notebook.google.com",
  "perplexity.ai", "mistral.ai", "cohere.ai", "cohere.com",
  "groq.com", "x.ai", "grok.com", "cursor.com",
  "cursor.sh", "cursorapi.com", "cursor-cdn.com", "together.ai",
  "replicate.com", "stability.ai", "midjourney.com", "poe.com",
  "character.ai", "inflection.ai", "pi.ai", "huggingface.co",
  "hf.co", "hf.space", "scite.ai", "muse.ai",
  "ai.meta.com",
];

const staticExact = [
  "challenges.cloudflare.com", "servd-anthropic-website.b-cdn.net",
];

const youtubeDomains = [
  "youtube.com", "youtube-nocookie.com", "youtu.be", "googlevideo.com",
  "ytimg.com", "ggpht.com", "youtubei.googleapis.com", "youtube.googleapis.com",
  "youtubeembeddedplayer.googleapis.com", "yt.be",
];

const youtubeExact = [
  "yt3.googleusercontent.com", "youtube-ui.l.google.com", "wide-youtube.l.google.com",
];

function main(config) {
  if (!["http", "socks5"].includes(staticProxy.type) ||
      !Number.isInteger(staticProxy.port) || staticProxy.port < 1 || staticProxy.port > 65535 ||
      [staticProxy.server, staticProxy.username, staticProxy.password].some(value =>
        typeof value !== "string" || !value.trim() || value.startsWith("YOUR_"))) {
    throw new Error("请在脚本顶部填写静态代理的协议、地址、端口、用户名和密码。");
  }

  const list = value => Array.isArray(value) ? value : [];
  const isChain = name => typeof name === "string" && name.startsWith(chainPrefix);
  const proxies = list(config.proxies).filter(proxy => proxy && typeof proxy.name === "string" && !isChain(proxy.name));
  const names = [...new Set(proxies.map(proxy => proxy.name))];
  if (names.length === 0) throw new Error("订阅缺少 proxies 节点。请使用包含独立节点的订阅。");
  if (names.some(name => [normalGroup, staticGroup].includes(name))) {
    throw new Error("订阅节点与脚本代理组同名，请先更改节点或组名。");
  }

  const chains = names.map(name => ({ ...staticProxy, name: chainPrefix + name, "dialer-proxy": name }));
  const chainNames = chains.map(proxy => proxy.name);
  const groups = list(config["proxy-groups"]).filter(group =>
    group && ![normalGroup, staticGroup].includes(group.name));
  if (groups.some(group => chainNames.includes(group.name))) {
    throw new Error("订阅代理组与生成的静态链路同名，请先更改链路前缀或组名。");
  }

  const urlTest = (name, choices, interval, timeout, tolerance, lazy) => ({
    name, type: "url-test", proxies: choices,
    url: "https://www.gstatic.com/generate_204", interval, timeout, tolerance, lazy,
  });
  config.proxies = [...proxies, ...chains];
  config["proxy-groups"] = [
    urlTest(staticGroup, chainNames, 60, 10000, 50, false),
    urlTest(normalGroup, names, 300, 5000, 100, true),
    ...groups,
  ];

  const domainRules = (suffixes, exact, group) => [
    ...suffixes.map(domain => "DOMAIN-SUFFIX," + domain + "," + group),
    ...exact.map(domain => "DOMAIN," + domain + "," + group),
  ];
  const rejectUdp = (kind, domain) => "AND,((NETWORK,UDP),(" + kind + "," + domain + ")),REJECT";
  // YouTube 先于 Google 规则匹配。静态出口使用 TCP，拒绝匹配这些域名的 UDP。
  const rules = [
    ...domainRules(youtubeDomains, youtubeExact, normalGroup),
    ...staticDomains.map(domain => rejectUdp("DOMAIN-SUFFIX", domain)),
    ...staticExact.map(domain => rejectUdp("DOMAIN", domain)),
    ...domainRules(staticDomains, staticExact, staticGroup),
  ];
  const builtIns = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]);
  const original = list(config.rules).filter(rule => typeof rule === "string").map(rule => {
    const parts = rule.split(",").map(part => part.trim());
    if (parts[0] === "MATCH" && parts.length === 2 && !builtIns.has(parts[1])) {
      return "MATCH," + normalGroup;
    }
    return rule;
  });
  if (!original.some(rule => /^\s*MATCH\s*,/.test(rule))) original.push("MATCH," + normalGroup);
  config.rules = [...new Set([...rules, ...original])];

  // 为静态域名和 YouTube 分别指定各自代理组的 DNS。
  const doh = group => ["https://1.1.1.1/dns-query#" + group, "https://8.8.8.8/dns-query#" + group];
  const policy = { ...config.dns?.["nameserver-policy"] };
  staticDomains.forEach(domain => { policy["+." + domain] = doh(staticGroup); });
  staticExact.forEach(domain => { policy[domain] = doh(staticGroup); });
  youtubeDomains.forEach(domain => { policy["+." + domain] = doh(normalGroup); });
  youtubeExact.forEach(domain => { policy[domain] = doh(normalGroup); });
  config.dns = {
    ...config.dns,
    enable: true,
    nameserver: doh(normalGroup),
    "nameserver-policy": policy,
    "proxy-server-nameserver": ["https://223.5.5.5/dns-query#DIRECT"],
    "default-nameserver": ["https://223.5.5.5/dns-query"],
    "prefer-h3": false,
    fallback: [],
  };
  delete config.dns["fallback-filter"];
  return config;
}
