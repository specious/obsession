import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import { readFileSync, writeFileSync } from 'fs'

// After build, patch dist/index.html to be fully self-contained:
// inline the CSS and JS rather than referencing external files.
//
// Benefits:
//   - Opens directly from the filesystem (file://) without CORS errors,
//     because inline <script type="module"> has no cross-origin request
//   - id="__bundle__" lets buildFullFeatured() read the bundle for re-export
//     by reading the script tag's textContent instead of storing a second copy
//
// The separate dist/assets/ files are kept intact — bun run preview and
// the full-featured export's fetch('./assets/index.js') still work normally.
function inlineAssetsPlugin() {
  return {
    name: 'inline-assets',
    apply: 'build',
    closeBundle() {
      const html = readFileSync('dist/index.html', 'utf8')
      const js   = readFileSync('dist/assets/index.js', 'utf8')
      const css  = readFileSync('dist/assets/style.css', 'utf8')

      // Two traps when embedding a JS bundle as inline HTML:
      //
      // 1. The HTML parser terminates a <script> block the moment it sees
      //    </script>, even inside a string literal. render.js builds HTML
      //    strings for the export feature, so the bundle contains "</script>"
      //    as source text. <\/script> sidesteps this: the HTML parser does not
      //    match it, while the JS engine treats \/ as plain / and ignores the
      //    backslash.
      const safeJs = js.replace(/<\/(script)/gi, '<\\/$1')

      // 2. String.replace() gives special meaning to $`, $', $&, and $$ in a
      //    replacement *string*. The JSON-stringified bundle contains both $`
      //    (from minified template literal comparisons) and $$ (from Rollup
      //    helpers), so a string replacement would silently corrupt the output.
      //    A replacement *function*'s return value is always used verbatim.
      const result = html
        .replace(/<link rel="stylesheet"[^>]*>/, () => `<style>${css}</style>`)
        .replace(
          /<script type="module"[^>]*><\/script>/,
          () => `<script type="module" id="__bundle__">${safeJs}</script>`
        )

      writeFileSync('dist/index.html', result)
    },
  }
}

export default defineConfig({
  plugins: [solid(), inlineAssetsPlugin()],
  base: './',
  build: {
    target: 'esnext',
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // Single chunk — required for the inline plugin to find exactly one
        // file to patch in, and for the self-replicating export to work.
        manualChunks: undefined,
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/index.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
