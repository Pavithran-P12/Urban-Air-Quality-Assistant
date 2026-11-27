/**
 * The two Deno APIs the Edge Function entry points use, so `npm run typecheck` can check them
 * without the full Deno type library. Supabase runs the real Deno runtime.
 */
declare namespace Deno {
  function serve(handler: (req: Request) => Response | Promise<Response>): unknown;
  const env: { get(name: string): string | undefined };
}
