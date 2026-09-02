import type { Env } from "./env";
import { generateRoomKey, normalizeRoomKey } from "./protocol";

export { GameRoom } from "./room";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/new-room") {
      return Response.json({ roomKey: generateRoomKey() });
    }

    if (url.pathname === "/api/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected a WebSocket upgrade.", { status: 426 });
      }
      const roomKey = normalizeRoomKey(url.searchParams.get("room") ?? "");
      if (roomKey.length < 4) {
        return new Response("Invalid room key.", { status: 400 });
      }
      // The room key IS the room's identity - one Durable Object per key.
      const id = env.GAME_ROOM.idFromName(roomKey);
      const stub = env.GAME_ROOM.get(id);
      const forwarded = new Request(`https://room/connect?room=${roomKey}`, request);
      return stub.fetch(forwarded);
    }

    // Everything else falls through to the static SPA assets.
    return new Response(null, { status: 404 });
  },
};
