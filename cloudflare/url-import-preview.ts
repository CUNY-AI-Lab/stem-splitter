/** Isolated class-code preview. Exercises the native Browser binding without changing CAIL identity. */
import app from '../src/index.ts';
import type { Env } from '../src/env.ts';
import { youtubeBrowserLoader } from './youtube-browser.ts';
export default {
  fetch(request: Request, env: Env, context: ExecutionContext) {
    return app.fetch(request, {...env, fetchYouTubeBrowserAudio: youtubeBrowserLoader(env.BROWSER)}, context);
  },
};
