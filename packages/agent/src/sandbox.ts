export type CommandResult = { exitCode: number | null; timedOut: boolean; output: string };

// Where the agent's tools act. Paths are relative to the sandbox's working directory.
// Implementations decide what "inside" means: a folder on this machine, or a container.
export interface Sandbox {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(command: string, timeoutMs: number): Promise<CommandResult>;
  destroy(): Promise<void>;
}
