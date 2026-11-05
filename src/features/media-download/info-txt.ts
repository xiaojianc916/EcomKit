import type { ProductSnapshot } from '../../kernel/model/product';
import { formatDateTime } from './format';

/**
 * 商品信息.txt（§9.12）。
 *
 * 两条硬性要求都有具体原因：
 * - **UTF-8 带 BOM**：Windows 记事本在旧版本里判断编码靠 BOM，不写 BOM 中文会乱码。
 * - **CRLF 换行**：同上，记事本对单独的 LF 处理不一致。
 *
 * 内容每次下载都整份覆盖重写，所以这里只负责「快照 + 时间 → 文本」的纯换算。
 */

export const UTF8_BOM = '\uFEFF';
export const CRLF = '\r\n';

export interface InfoTxtInput {
  snapshot: ProductSnapshot;
  /** 下载时间（毫秒时间戳） */
  at: number;
}

function line(...cells: string[]): string {
  return cells.join('\t');
}

/**
 * 生成 txt 正文（含 BOM 和 CRLF）。
 * 纯函数：同样的输入永远得到同样的字节，便于做快照测试。
 */
export function buildInfoTxt(input: InfoTxtInput): string {
  const { snapshot, at } = input;
  const rows: string[] = [];

  const kv = (key: string, value: string | undefined): void => {
    if (value === undefined || value.trim() === '') return;
    rows.push(`${key}：${value.trim()}`);
  };

  kv('标题', snapshot.title);
  kv('商品 ID', snapshot.productId);
  kv('链接', snapshot.url);
  kv('店铺', snapshot.shopName);
  kv('价格', snapshot.price);
  kv('下载时间', formatDateTime(at, at));

  if (snapshot.skus.length > 0) {
    rows.push('');
    rows.push('SKU 表（规格 / 价格 / 库存）');
    for (const sku of snapshot.skus) {
      const specs = sku.specs.map((s) => `${s.name}=${s.value}`).join(' ');
      const cells = [specs === '' ? '-' : specs];
      if (sku.price !== undefined && sku.price.trim() !== '') cells.push(sku.price.trim());
      if (sku.stock !== undefined) cells.push(String(sku.stock));
      rows.push(line(...cells));
    }
  }

  return UTF8_BOM + rows.join(CRLF) + CRLF;
}

/** txt 的字节长度，写清单时用（§9.11 的 size 要和真实落盘一致） */
export function infoTxtBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
