import { Packr, UnpackrStream, addExtension, unpack } from "msgpackr";
import { EventEmitter } from "node:events";
import net from "node:net";
import { createLogger, prettyRPCMessage } from "./logger.ts";
import {
    MessageType,
    type AttachParams,
    type BaseEvents,
    type EventHandler,
    type Nvim,
    type RPCMessage,
    type RPCNotification,
    type RPCRequest,
    type RPCResponse,
} from "./types.ts";

const packr = new Packr({ useRecords: false });
const unpackrStream = new UnpackrStream({ useRecords: false });

[0, 1, 2].forEach((type) => {
    // https://neovim.io/doc/user/api.html#api-definitions
    // decode Buffer, Window, and Tabpage as numbers
    // Buffer   id: 0    prefix: nvim_buf_
    // Window   id: 1    prefix: nvim_win_
    // Tabpage  id: 2    prefix: nvim_tabpage_
    addExtension({ type, unpack: (buffer) => unpack(buffer) as number });
});

export async function attach<ApiInfo extends BaseEvents = BaseEvents>({
    socket,
    client,
    logging,
}: AttachParams): Promise<Nvim<ApiInfo>> {
    const logger = createLogger(client, logging);
    const messageOutQueue: RPCMessage[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notificationHandlers = new Map<string, Record<string, EventHandler<any, unknown>>>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestHandlers = new Map<string, EventHandler<any, unknown>>();
    const emitter = new EventEmitter({ captureRejections: true });

    let lastReqId = 0;
    let handlerId = 0;

    const nvimSocket = await new Promise<net.Socket>((resolve, reject) => {
        const client = new net.Socket();
        client.once("error", reject);
        client.once("connect", () => {
            client
                .removeListener("error", reject)
                .on("data", (data: Buffer) => {
                    unpackrStream.write(data);
                })
                .on("error", (error) => {
                    logger?.error("socket error", error);
                })
                .on("end", () => {
                    logger?.debug("connection closed by neovim");
                })
                .on("close", () => {
                    logger?.debug("connection closed by bunvim");
                });
            resolve(client);
        });

        client.connect(socket);
    });

    function processMessageOutQueue() {
        // All writing to neovim happens through this function.
        // Outgoing RPC messages are added to the `messageOutQueue` and sent ASAP
        if (!messageOutQueue.length) return;

        const message = messageOutQueue.shift();
        if (!message) {
            logger?.error("Cannot process undefined message");
            return;
        }

        logger?.debug(prettyRPCMessage(message, "out"));
        nvimSocket.write(packr.pack(message) as unknown as Uint8Array);
        processMessageOutQueue();
    }

    function runNotificationHandlers(message: RPCNotification) {
        // message[1] notification name
        // message[2] args
        const handlers = notificationHandlers.get(message[1]);
        if (!handlers) return;

        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        Object.entries(handlers).forEach(async ([id, handler]) => {
            const result = await handler(message[2]);
            // remove notification handler if it returns specifically `true`
            // other truthy values won't trigger the removal
            // eslint-disable-next-line
            if (result === true) delete handlers[id];
        });
    }

    unpackrStream.on("data", (message: RPCMessage) => {
        (async () => {
            logger?.debug(prettyRPCMessage(message, "in"));
            if (message[0] === MessageType.NOTIFY) {
                // asynchronously run notification handlers.
                // RPCNotifications don't need a response
                runNotificationHandlers(message);
            }

            if (message[0] === MessageType.RESPONSE) {
                // message[1] reqId
                // message[2] error
                // message[3] result
                emitter.emit(`response-${message[1]}`, message[2], message[3]);
            }

            if (message[0] === MessageType.REQUEST) {
                // message[1] reqId
                // message[2] method name
                // message[3] args
                const handler = requestHandlers.get(message[2]);

                // RPCRequests block neovim until a response is received.
                // RPCResponse is added to beginning of queue to be sent ASAP.
                if (!handler) {
                    const notFound: RPCResponse = [
                        MessageType.RESPONSE,
                        message[1],
                        `no handler for method ${message[2]} found`,
                        null,
                    ];
                    messageOutQueue.unshift(notFound);
                } else {
                    try {
                        const result = await handler(message[3]);
                        const response: RPCResponse = [
                            MessageType.RESPONSE,
                            message[1],
                            null,
                            result,
                        ];
                        messageOutQueue.unshift(response);
                    } catch (err) {
                        const response: RPCResponse = [
                            MessageType.RESPONSE,
                            message[1],
                            String(err),
                            null,
                        ];
                        messageOutQueue.unshift(response);
                    }
                }
            }

            // Continue processing queue
            processMessageOutQueue();
        })().catch((err: unknown) => logger?.error("unpackrStream error", err));
    });

    const call: Nvim["call"] = (func, args) => {
        const reqId = ++lastReqId;
        const request: RPCRequest = [MessageType.REQUEST, reqId, func as string, args];

        return new Promise((resolve, reject) => {
            // Register response listener before adding request to queue to avoid
            // response coming in before listener was set up.
            emitter.once(`response-${reqId}`, (error, result) => {
                if (error) reject(error as Error);
                resolve(result as unknown);
            });

            messageOutQueue.push(request);
            // Start processing queue if we're not already
            processMessageOutQueue();
        });
    };

    await call("nvim_set_client_info", [
        client.name,
        client.version ?? {},
        client.type ?? "msgpack-rpc",
        client.methods ?? {},
        client.attributes ?? {},
    ]);

    const channelId = (await call("nvim_get_api_info", []))[0] as number;

    return {
        call,
        channelId,
        logger: logger,
        onNotification(notification, callback) {
            const handlers = notificationHandlers.get(notification as string) ?? {};
            handlers[++handlerId] = callback;
            notificationHandlers.set(notification as string, handlers);
        },
        onRequest(method, callback) {
            requestHandlers.set(method as string, callback);
        },
        detach() {
            nvimSocket.end();
        },
    };
}
