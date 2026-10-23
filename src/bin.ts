#!/usr/bin/env node
import { run } from './cli.js';

process.exitCode = await run(process.argv.slice(2), {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  env: process.env,
  cwd: process.cwd(),
  color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
});
