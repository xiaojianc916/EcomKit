const config = {
  ignore: {
    // `.phase0-raw/` 是本地采样产物（含第三方 Chrome 扩展的打包代码），
    // 已在 .gitignore 中忽略，不属于本项目源码，扫描时整体排除。
    files: ['.phase0-raw/**'],
  },
};

export default config;
