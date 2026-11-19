// Extra esbuild options for the Lambda bundles (serverless.yml → build.esbuild.configFile). Merged with the options in
// serverless.yml, which take precedence.
// The bundles are ESM (.mjs) but most dependencies are CommonJS and call `require('http')`, `require('crypto')`… at
// load time; an ESM module has no `require`, so without this banner the function fails with
// "Dynamic require of "http" is not supported" (seen with serverless-http). The banner gives every bundle a real
// `require` bound to the bundle's own location.
export default () => ({
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
