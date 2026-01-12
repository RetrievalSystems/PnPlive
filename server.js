import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true, // allow all origins for now (safe for testing)
    methods: ["GET", "POST"]
  }
});

// Simple health check
app.get("/", (_req, res) => {
  res.send("Herbalist Wizards realtime server running");
});

/**
 * Room structure:
 * rooms[code] = {
 *   hostSocketId,
 *   seats: { Y: socketId, B: socketId | null },
 *   lastState: null
 * }
 */
const rooms = new Map();

function makeCode(len = 5) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // Host creates a room
  socket.on("host_room", (cb) => {
    let code = makeCode();
    while (rooms.has(code)) code = makeCode();

    rooms.set(code, {
      hostSocketId: socket.id,
      seats: { Y: socket.id, B: null },
      lastState: null
    });

    socket.join(code);
    console.log("Room hosted:", code);

    cb?.({ ok: true, code, seat: "Y" });
  });

  // Join an existing room
  socket.on("join_room", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "Room not found" });
    if (room.seats.B) return cb?.({ ok: false, error: "Room already full" });

    room.seats.B = socket.id;
    socket.join(code);
    console.log("Joined room:", code);

    io.to(code).emit("room_ready");

    if (room.lastState) {
      socket.emit("state_sync", room.lastState);
    }

    cb?.({ ok: true, code, seat: "B" });
  });

  // Shared cursor (Stage 1)
  socket.on("cursor", ({ code, x, y }) => {
    if (!rooms.has(code)) return;
    socket.to(code).emit("cursor", { from: socket.id, x, y });
  });

  // Ping / laser pointer (Stage 1)
  socket.on("ping", ({ code, x, y }) => {
    if (!rooms.has(code)) return;
    io.to(code).emit("ping", {
      from: socket.id,
      x,
      y,
      t: Date.now()
    });
  });

// Relay JSON-safe game-state snapshots to everyone else in the room
socket.on("state_sync", (payload) => {
  try {
    const code = String(payload?.code || "").trim().toUpperCase();
    const json = payload?.json;
    if (!code || typeof json !== "string") return;
    if (!rooms.has(code)) return;

    // Relay to everyone else in the room (not back to sender)
    socket.to(code).emit("state_sync", { json });
  } catch (e) {
    console.error("state_sync error", e);
  }
});


  // Gameplay action relay (Stage 2)
  socket.on("action", ({ code, action }) => {
    if (!rooms.has(code)) return;
    io.to(code).emit("action", { from: socket.id, action });
  });

  // Host sends full snapshot (authoritative)
  socket.on("snapshot", ({ code, state }) => {
    const room = rooms.get(code);
    if (!room) return;
    room.lastState = state;
    io.to(code).emit("state_sync", state);
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    for (const [code, room] of rooms.entries()) {
      if (room.hostSocketId === socket.id) {
        io.to(code).emit("room_closed");
        rooms.delete(code);
      } else if (room.seats.B === socket.id) {
        room.seats.B = null;
        io.to(code).emit("player_left");
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
