// src/renderer/assets.d.ts — let TypeScript accept image imports (Vite bundles them)
declare module '*.png' {
  const url: string;
  export default url;
}
