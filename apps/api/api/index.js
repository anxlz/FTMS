// Vercel function entry point. Every request is rewritten here by `vercel.json`.
// The API is compiled by `nest build` first, so this file only loads the compiled
// handler — Vercel never has to transpile Nest's decorators itself.
module.exports = require('../dist/vercel.js').default;
