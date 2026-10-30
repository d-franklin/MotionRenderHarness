import { existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

export interface PageServer {
  url: string;
  port: number;
  stop: () => void;
}

/**
 * Serves a directory over http. The page is never loaded over file://, which
 * blocks ES modules and workers.
 */
export function startServer(root: string): PageServer {
  const rootPath = resolve(root);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      try {
        return await serve(rootPath, new URL(request.url));
      } catch (error) {
        return new Response(`internal error: ${(error as Error).message}`, { status: 500 });
      }
    },
  });

  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new Error("the page server did not get a port");
  }

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stop: () => server.stop(true),
  };
}

async function serve(root: string, url: URL): Promise<Response> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("bad request", { status: 400 });
  }

  let filePath = resolve(root, `.${pathname}`);
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    return new Response("forbidden", { status: 403 });
  }
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, "index.html");
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return new Response(`not found: ${pathname}`, { status: 404 });
  }

  const type = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  return new Response(file, {
    headers: {
      "Content-Type": type,
      // A render must not depend on what a previous run left in the cache.
      "Cache-Control": "no-store",
    },
  });
}
