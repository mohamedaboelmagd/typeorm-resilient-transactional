/**
 * size-limit defaults to a browser-ish esbuild target, which cannot resolve
 * `node:async_hooks`. This is a Node library, so say so.
 */
const nodePlatform = (config) => {
  config.platform = 'node';
  return config;
};

module.exports = [
  {
    name: 'index (ESM, brotli)',
    path: 'dist/index.mjs',
    limit: '12 kB',
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'index (CJS, brotli)',
    path: 'dist/index.js',
    limit: '12 kB',
    modifyEsbuildConfig: nodePlatform,
  },
  {
    name: 'compat (ESM, brotli)',
    path: 'dist/compat.mjs',
    limit: '12 kB',
    modifyEsbuildConfig: nodePlatform,
  },
];
