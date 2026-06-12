declare var require: any;
const pty = require('node-pty');
import * as readline from 'readline';

// Redirect console.log to stderr so it does not interfere with the IPC JSON messages on stdout.
console.log = (...args: any[]) => {
  process.stderr.write(`[PTY Bridge Log] ${args.join(' ')}\n`);
};
console.error = (...args: any[]) => {
  process.stderr.write(`[PTY Bridge Error] ${args.join(' ')}\n`);
};

function sendIPC(msg: any) {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch (err: any) {
    process.stderr.write(`[PTY Bridge] Error sending IPC message: ${err.message}\n`);
  }
}

let ptyProcess: any;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  if (!line.trim()) return;

  try {
    const message = JSON.parse(line);
    handleMessage(message);
  } catch (err: any) {
    sendIPC({ event: 'error', message: `Failed to parse IPC message: ${err.message}` });
  }
});

function handleMessage(msg: any) {
  switch (msg.action) {
    case 'spawn':
      handleSpawn(msg);
      break;
    case 'write':
      handleWrite(msg);
      break;
    case 'resize':
      handleResize(msg);
      break;
    case 'kill':
      handleKill();
      break;
    default:
      sendIPC({ event: 'error', message: `Unknown action: ${msg.action}` });
  }
}

function handleSpawn(msg: any) {
  if (ptyProcess) {
    sendIPC({ event: 'error', message: 'PTY is already spawned' });
    return;
  }

  const { shell, args, cols, rows, cwd, env } = msg;

  try {
    // Merge env
    const mergedEnv = Object.assign({}, process.env, env);

    ptyProcess = pty.spawn(shell, args || [], {
      name: 'xterm-color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: cwd || process.cwd(),
      env: mergedEnv
    });

    sendIPC({ event: 'spawned', pid: ptyProcess.pid });
    ptyProcess.onData((data: string) => {
      sendIPC({ event: 'output', data });
    });

    ptyProcess.onExit((event: any) => {
      sendIPC({ event: 'exit', code: event.exitCode, signal: event.signal });
      ptyProcess = undefined;
    });

  } catch (err: any) {
    sendIPC({ event: 'error', message: `Failed to spawn PTY: ${err.message}` });
  }
}

function handleWrite(msg: any) {
  if (!ptyProcess) {
    sendIPC({ event: 'error', message: 'No active PTY process to write to' });
    return;
  }
  try {
    ptyProcess.write(msg.data);
  } catch (err: any) {
    sendIPC({ event: 'error', message: `Failed to write to PTY: ${err.message}` });
  }
}

function handleResize(msg: any) {
  if (!ptyProcess) {
    return;
  }
  try {
    ptyProcess.resize(msg.cols, msg.rows);
  } catch (err: any) {
    sendIPC({ event: 'error', message: `Failed to resize PTY: ${err.message}` });
  }
}

function handleKill() {
  if (!ptyProcess) {
    return;
  }
  try {
    ptyProcess.kill();
  } catch (err: any) {
    process.stderr.write(`[PTY Bridge] Failed to kill PTY: ${err.message}\n`);
  } finally {
    ptyProcess = undefined;
  }
}

// Clean up PTY on exit or sudden termination
const cleanExit = () => {
  handleKill();
  process.exit(0);
};

process.on('exit', () => {
  handleKill();
});
process.on('SIGINT', cleanExit);
process.on('SIGTERM', cleanExit);
process.on('uncaughtException', (err) => {
  process.stderr.write(`[PTY Bridge] Uncaught Exception: ${err.message}\n${err.stack}\n`);
  cleanExit();
});
