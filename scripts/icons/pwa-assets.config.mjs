// Full-bleed maskable + Apple touch icons (the default preset pads them with white).
// Run from the project root:  npx -y @vite-pwa/assets-generator --config scripts/icons/pwa-assets.config.mjs
// then move scripts/icons/maskable-icon-512x512.png and apple-touch-icon-180x180.png into public/.
export default {
  headLinkOptions: { preset: '2023' },
  preset: {
    transparent: { sizes: [], favicons: [] },
    maskable: { sizes: [512], padding: 0 },
    apple: { sizes: [180], padding: 0 },
  },
  images: ['scripts/icons/icon-fullbleed.svg'],
}
