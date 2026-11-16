import { WorkerEntrypoint } from 'cloudflare:workers';
import { serveTools } from './tools.ts';
import type { WorkerEnv } from './worker.ts';

export { default } from './worker.ts';

/** Private ingress: only Doorway supplies the app and Gateway identity legs. */
export class ToolsApp extends WorkerEntrypoint<WorkerEnv> {
  fetch(request: Request): Promise<Response> {
    return serveTools(request, this.env, this.ctx);
  }
}
