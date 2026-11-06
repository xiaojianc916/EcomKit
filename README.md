# 电商素材工具箱（EcomKit）

拼多多、抖音商城商品页的**主图 / SKU 图 / 详情图 / 视频**归档下载扩展。
Chrome / Edge MV3，Windows 10 22H2 与 Windows 11，浏览器 122 及以上。

- 内部自用，不登录、不上报、不读 Cookie
- 进入商品页自动出现工具箱，一次点击把素材按 `根目录/<平台名>_商品ID_<商品ID>/{主图,SKU图,详情图,视频}` 归档
- 目录里只有素材本身，不写 `商品信息.txt`、不写任何记录文件，拿到就能直接上传
- 文件名一眼可认：`主图01.jpg`、`详情图01.jpg`、`SKU01_杏色.jpg`、`视频01.mp4`
- 同一商品重复下载只补缺失文件，商家改了标题也不会另建文件夹

## 快速开始

```bash
pnpm install
node scripts/gen-key.ts     # 生成固定扩展 ID 的密钥对（只需一次）
pnpm dev                    # 启动带扩展的 Chrome，支持热更新
pnpm check                  # Biome + TypeScript + dependency-cruiser + 单元测试
pnpm build                  # 产物在 .output/chrome-mv3/
```

## 安装

1. 把 `.output/chrome-mv3/` 整个目录复制到固定位置，例如 `D:\Tools\EcBox`
2. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`
3. 打开「开发者模式」→「加载已解压的扩展程序」→ 选择那个文件夹
4. 把扩展图标固定到工具栏

只要 `keys/public-key.b64` 不变，扩展 ID 就不变，设置和目录授权在更新后都会保留。

## 使用

1. 打开拼多多或抖音商城的商品详情页
2. 右侧出现工具箱，识别完成后展示四类素材
3. 第一次点下载会让你选一个保存文件夹，建议新建 `D:\电商素材` 这样的专用目录
4. 之后所有商品都在根目录下按 `平台名_商品ID_商品ID` 自动归档，例如：

```
D:\电商素材\
└── 拼多多_商品ID_1019084314929\
    ├── 主图\    主图01.jpg  主图02.jpg
    ├── SKU图\   SKU01_杏色.jpg  SKU02_藏青.jpg
    ├── 详情图\  详情图01.jpg …
    └── 视频\    视频01.mp4
```

**注意**：拼多多未登录会跳转登录页，需要先登录再刷新；抖音商城详情页在桌面浏览器上只显示扫码提示，属于平台限制。

## 目录结构

见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 开发

见 [CONTRIBUTING.md](./CONTRIBUTING.md)。完整设计见 [项目架构设计方案.md](./项目架构设计方案.md)。

## 密钥

`scripts/gen-key.ts` 生成的私钥在 `keys/private-key.pem`，**不入库**，由负责人备份。
公钥 `keys/public-key.b64` 决定了固定的扩展 ID，也不要轻易重新生成。
