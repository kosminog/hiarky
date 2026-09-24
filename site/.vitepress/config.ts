import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'hiarky',
  description:
    'Snapshot what your project declares — components, routes, API procedures, database models, migrations, config — and review how it changes over time.',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['meta', { property: 'og:title', content: 'hiarky' }],
    [
      'meta',
      {
        property: 'og:description',
        content: 'Review what your code declares, not just which lines moved.',
      },
    ],
  ],
  themeConfig: {
    logo: { light: '/logo.svg', dark: '/logo-dark.svg', alt: 'hiarky' },
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Philosophy', link: '/philosophy' },
      { text: 'Changelog', link: '/changelog' },
      { text: 'npm', link: 'https://www.npmjs.com/package/hiarky' },
    ],
    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Philosophy', link: '/philosophy' },
          { text: 'Getting started', link: '/guide/getting-started' },
        ],
      },
      {
        text: 'Guide',
        items: [
          { text: 'Commands', link: '/guide/commands' },
          { text: 'What a snapshot captures', link: '/guide/snapshots' },
          { text: 'Languages and files', link: '/guide/languages' },
          { text: 'Reviewing changes', link: '/guide/review' },
          { text: 'The viewer', link: '/guide/viewer' },
        ],
      },
      {
        text: 'Internals',
        items: [
          { text: 'Scanning and caching', link: '/guide/scanning' },
          { text: 'Adding a language', link: '/guide/extending' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/kosminog/hiarky' }],
    editLink: {
      pattern: 'https://github.com/kosminog/hiarky/edit/main/site/:path',
      text: 'Edit this page on GitHub',
    },
    search: { provider: 'local' },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © Kosminog',
    },
  },
});
