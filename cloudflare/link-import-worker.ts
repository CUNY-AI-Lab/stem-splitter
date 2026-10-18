import { handleLinkImportRequest, type LinkImportEnv } from '../src/link-import.ts';

/** cail-stem-import: no public route; the splitter reaches it only through its LINK_IMPORT service binding. */
export default {
  fetch(request: Request, env: LinkImportEnv): Promise<Response> {
    return handleLinkImportRequest(request, env);
  },
};
