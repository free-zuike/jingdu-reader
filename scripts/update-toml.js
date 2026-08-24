// 更新 wrangler.toml 中的 D1/KV ID 和密钥
// 用法: node scripts/update-toml.js <d1_id> <kv_id> <jwt_secret> <encryption_key>
const fs = require('fs');
let content = fs.readFileSync('wrangler.toml', 'utf8');
// process.argv: [node, script, arg1, arg2, ...] 所以参数从 index 2 开始
const [, , d1_id, kv_id, jwt_secret, encryption_key] = process.argv;

content = content.replace(/database_id = ".*"/, `database_id = "${d1_id}"`);
content = content.replace(/(binding = "CACHE"\n\s*id = )".*"/, `$1"${kv_id}"`);
content = content.replace(/^JWT_SECRET = ".*"/m, `JWT_SECRET = "${jwt_secret}"`);
content = content.replace(/^ENCRYPTION_KEY = ".*"/m, `ENCRYPTION_KEY = "${encryption_key}"`);

fs.writeFileSync('wrangler.toml', content);
console.log('OK: database_id=' + d1_id);
console.log('OK: kv_id=' + kv_id);