/** The established URL serves the current candidate, not the legacy app.
 * Keep authentication, data, provider secrets and streaming in one backend. */
export default {
  async fetch(request: Request, env: AliasBindings): Promise<Response> {
    try {
      return await env.STEM_APP.fetch(request);
    } catch {
      return Response.json({ error: 'The service is temporarily unavailable. Please try again.' }, {
        status: 503,
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    }
  },
} satisfies ExportedHandler<AliasBindings>;
