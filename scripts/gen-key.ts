/**
 * 生成固定扩展 ID 用的 RSA 密钥对（§14）。
 *
 * 为什么必须做这件事：以「加载已解压的扩展程序」方式安装时，扩展 ID 由**文件夹路径**决定。
 * 文件夹一挪动 ID 就变，设置、目录授权和文件夹索引会全部丢失。
 * 把公钥写进 manifest.key 后，不管装在哪个位置、装在哪台电脑上，ID 都恒定。
 *
 * 用法：
 *   node scripts/gen-key.ts
 *
 * 产物：
 *   keys/private-key.pem   ← **私钥，绝不入库**（.gitignore 已排除 keys/）
 *   keys/public-key.b64    ← 公钥（base64），写进构建环境变量 ECBOX_PUBLIC_KEY
 *   keys/extension-id.txt  ← 由此公钥推导出的扩展 ID，方便核对
 */
import { generateKeyPairSync, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const keysDir = join(root, 'keys');

function main(): void {
  const force = process.argv.includes('--force');
  const pubPath = join(keysDir, 'public-key.b64');

  if (existsSync(pubPath) && !force) {
    const pub = readFileSync(pubPath, 'utf8').trim();
    console.log('密钥已存在，跳过生成。');
    console.log('扩展 ID:', extensionIdFromPublicKey(pub));
    console.log('如需重新生成（会改变扩展 ID，导致设置和授权丢失），加 --force');
    return;
  }

  mkdirSync(keysDir, { recursive: true });

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const pubB64 = Buffer.from(publicKey).toString('base64');

  writeFileSync(join(keysDir, 'private-key.pem'), privateKey, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(pubPath, pubB64 + '\n', 'utf8');

  const id = extensionIdFromPublicKey(pubB64);
  writeFileSync(join(keysDir, 'extension-id.txt'), id + '\n', 'utf8');

  console.log('已生成密钥：');
  console.log('  keys/private-key.pem  （私钥，不入库，请自行备份）');
  console.log('  keys/public-key.b64   （公钥，写进 manifest.key）');
  console.log('扩展 ID:', id);
}

/**
 * Chrome 的扩展 ID 推导规则：公钥 DER 的 sha256 取前 16 字节，
 * 每个字节取高 4 位和低 4 位，映射到 a-p 的字母。
 */
export function extensionIdFromPublicKey(pubB64: string): string {
  const der = Buffer.from(pubB64, 'base64');
  const hash = createHash('sha256').update(der).digest().subarray(0, 16);
  let out = '';
  for (const byte of hash) {
    out += String.fromCharCode(97 + (byte >> 4));
    out += String.fromCharCode(97 + (byte & 0x0f));
  }
  return out;
}

main();
