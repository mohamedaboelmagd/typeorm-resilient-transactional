import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    compat: 'src/compat/index.ts',
    // Separate so importing the package root never pulls in @nestjs/common,
    // which is an optional peer.
    nestjs: 'src/nestjs/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'node20',
  platform: 'node',
  // Zero runtime dependencies: everything importable is a peer, and peers must
  // never be inlined into the bundle.
  external: ['typeorm', '@nestjs/common', '@nestjs/core', 'reflect-metadata', '@opentelemetry/api'],
});
