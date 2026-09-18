import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

export interface FakeSpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
  readonly child: FakeChildProcess;
}

/**
 * In-memory test double for ChildProcess.
 * Lives strictly in test/support/; production code carries zero test doubles.
 */
export class FakeChildProcess extends EventEmitter {
  public readonly pid: number;
  public readonly stdin: PassThrough;
  public readonly stdout: PassThrough;
  public readonly stderr: PassThrough;
  public readonly stdio: [PassThrough, PassThrough, PassThrough];
  public killed = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public stdinData: Buffer = Buffer.alloc(0);

  public constructor(pid = 12345) {
    super();
    this.pid = pid;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdio = [this.stdin, this.stdout, this.stderr];

    this.stdin.on('data', (chunk: Buffer) => {
      this.stdinData = Buffer.concat([this.stdinData, chunk]);
    });
  }

  public kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.killed = true;
    this.signalCode = typeof signal === 'string' ? signal : 'SIGTERM';
    return true;
  }

  public simulateClose(
    code: number | null,
    signal: NodeJS.Signals | null = null,
  ): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('close', code, signal);
  }

  public simulateError(error: Error): void {
    this.emit('error', error);
  }
}

/**
 * In-memory test double for process.kill.
 * Intercepts negative-PID process group kills without executing OS syscalls.
 */
export class FakeProcessKiller {
  public killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  public onKill?: (pid: number, signal: NodeJS.Signals) => void;

  public kill = (pid: number, signal: NodeJS.Signals): void => {
    this.killed.push({ pid, signal });
    if (this.onKill) {
      this.onKill(pid, signal);
    }
  };

  public reset(): void {
    this.killed = [];
    this.onKill = undefined;
  }
}

/**
 * In-memory test double for child_process.spawn.
 */
export class FakeSpawner {
  public calls: FakeSpawnCall[] = [];
  public nextChildHandler?: (call: FakeSpawnCall) => void;

  public spawn = (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcess => {
    const child = new FakeChildProcess(10000 + this.calls.length + 1);
    const call: FakeSpawnCall = { command, args, options, child };
    this.calls.push(call);
    if (this.nextChildHandler) {
      this.nextChildHandler(call);
    }
    return child as unknown as ChildProcess;
  };

  public reset(): void {
    this.calls = [];
    this.nextChildHandler = undefined;
  }
}
