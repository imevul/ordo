import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { type Io, run } from './main.ts';

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** One line from the terminal; hidden input echoes nothing (for API keys). */
function prompt(question: string, opts: { hidden?: boolean } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  if (opts.hidden) {
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.startsWith(question)) write.call(rl, question);
      else if (s.includes('\n')) write.call(rl, '\n');
    };
  }
  return new Promise<string>((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    }),
  );
}

function openUrl(url: string) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true })
    .on('error', () => process.stdout.write(`${url}\n`))
    .unref();
}

// `ordo agent run` winds down on the first Ctrl-C (no new runs) and quits on the second.
const interrupted = new AbortController();
if (process.argv[2] === 'agent')
  process.on('SIGINT', () => {
    if (interrupted.signal.aborted) process.exit(130);
    interrupted.abort();
  });

const io: Io = {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin,
  prompt,
  openUrl,
  color: process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb',
  width: process.stdout.columns || 100,
  signal: interrupted.signal,
};

process.exitCode = await run(process.argv.slice(2), io);
