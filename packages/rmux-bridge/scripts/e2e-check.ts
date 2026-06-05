const port = Number.parseInt(process.env.PORT ?? "7820", 10);
const session = process.env.SESSION ?? "spine-test";
const url = `ws://127.0.0.1:${port}/attach?session=${encodeURIComponent(session)}`;
const decoder = new TextDecoder();

type ClientHandle = {
  name: string;
  socket: WebSocket;
  frames: string[];
  opened: Promise<void>;
  firstFrame: Promise<void>;
};

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function frameToText(data: string | ArrayBuffer | Blob | ArrayBufferView): Promise<string> {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return decoder.decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return await data.text();
}

function createClient(name: string): ClientHandle {
  const socket = new WebSocket(url);
  const frames: string[] = [];
  let openedResolve!: () => void;
  let openedReject!: (error: Error) => void;
  let firstFrameResolve!: () => void;
  let firstFrameReject!: (error: Error) => void;
  let sawFrame = false;

  const opened = new Promise<void>((resolve, reject) => {
    openedResolve = resolve;
    openedReject = reject;
  });

  const firstFrame = new Promise<void>((resolve, reject) => {
    firstFrameResolve = resolve;
    firstFrameReject = reject;
  });

  socket.addEventListener("open", () => {
    openedResolve();
  });

  socket.addEventListener("message", async (event) => {
    const text = await frameToText(event.data);
    frames.push(text);
    if (!sawFrame) {
      sawFrame = true;
      firstFrameResolve();
    }
  });

  socket.addEventListener("error", () => {
    const error = new Error(`${name} websocket error`);
    openedReject(error);
    if (!sawFrame) {
      firstFrameReject(error);
    }
  });

  socket.addEventListener("close", (event) => {
    const error = new Error(`${name} websocket closed (${event.code})`);
    if (socket.readyState !== WebSocket.OPEN) {
      openedReject(error);
    }
    if (!sawFrame) {
      firstFrameReject(error);
    }
  });

  return { name, socket, frames, opened, firstFrame };
}

function dumpClient(client: ClientHandle): string {
  return `${client.name}: ${client.frames.length} frame(s)\n${client.frames.join("\n---\n")}`;
}

async function waitForBridgeOk(a: ClientHandle, b: ClientHandle): Promise<boolean> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const aOk = a.frames.some((frame) => frame.includes("BRIDGE_OK"));
    const bOk = b.frames.some((frame) => frame.includes("BRIDGE_OK"));
    if (aOk && bOk) {
      return true;
    }
    await Bun.sleep(50);
  }
  return false;
}

const overall = setTimeout(() => {
  console.error("[e2e] overall timeout after 8000ms");
  process.exit(1);
}, 8000);

const clientA = createClient("A");
const clientB = createClient("B");

try {
  await timeout(clientA.opened, 3000, "client A open");
  await timeout(clientA.firstFrame, 3000, "client A first snapshot");

  clientA.socket.send(JSON.stringify({ type: "input", data: "echo BRIDGE_OK\n" }));

  await timeout(clientB.opened, 3000, "client B open");
  await timeout(clientB.firstFrame, 3000, "client B first frame");

  const ok = await waitForBridgeOk(clientA, clientB);
  if (!ok) {
    console.error("[e2e] BRIDGE_OK was not observed by both clients");
    console.error(dumpClient(clientA));
    console.error(dumpClient(clientB));
    process.exit(1);
  }

  console.log(`[e2e] success: both clients observed BRIDGE_OK on ${session} via ${url}`);
  process.exit(0);
} catch (error) {
  console.error("[e2e] failed:", error instanceof Error ? error.message : String(error));
  console.error(dumpClient(clientA));
  console.error(dumpClient(clientB));
  process.exit(1);
} finally {
  clearTimeout(overall);
  clientA.socket.close();
  clientB.socket.close();
}
