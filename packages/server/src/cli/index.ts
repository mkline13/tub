#!/usr/bin/env bun
// `tub` admin CLI: init, scopes, credentials, schemas, backup (see SPEC.md section 11).
const [command] = process.argv.slice(2)
console.log(command ? `tub: '${command}' is not implemented yet` : "usage: tub <command>")
