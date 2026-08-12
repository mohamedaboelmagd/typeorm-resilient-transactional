// @ts-check
import { defineConfig, passthroughImageService } from 'astro/config';
import starlight from '@astrojs/starlight';

const REPO = 'https://github.com/mohamedaboelmagd/typeorm-resilient-transactional';

export default defineConfig({
  site: 'https://mohamedaboelmagd.github.io',
  base: '/typeorm-resilient-transactional',
  // The only image here is a generated SVG, which has nothing to optimise —
  // the default service would pull in `sharp` to resize a vector. Passthrough
  // keeps the docs build dependency-free, and matches the repo's zero-runtime-
  // dependency habit even though nothing here ships to npm.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: 'typeorm-resilient-transactional',
      description:
        '@Transactional() for NestJS + TypeORM that survives deadlocks and serialization failures.',
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/master/` },
      sidebar: [
        { label: 'Overview', link: '/' },
        {
          label: 'Guides',
          items: [
            { label: 'Safety', link: '/safety/' },
            { label: 'Lock ordering', link: '/lock-ordering/' },
            { label: 'Migration', link: '/migration/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Internals', link: '/internals/' },
            { label: 'Benchmarks', link: '/benchmarks/' },
            { label: 'Prior art', link: '/prior-art/' },
          ],
        },
        { label: 'Decisions', items: [{ autogenerate: { directory: 'adr' } }] },
      ],
    }),
  ],
});
