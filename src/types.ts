export type Session = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
};

export type Message = {
    id: string;
    sessionId: string;
    role: "user" | "assistant";
    createdAt: number;
};

export type TextPart = {
    id: string;
    sessionId: string;
    messageId: string;
    type: "text";
    text: string;
    createdAt: number;
};

export type Part = TextPart;

export type BusEvent =
    | { type: "session.status"; sessionId: string; status: "idle" | "busy" | "error" }
    | { type: "message.created"; message: Message }
    | { type: "part.updated"; part: Part }
    | { type: "part.delta"; sessionId: string; messageId: string; partId: string; delta: string }
    | { type: "session.error"; sessionId: string; error: string };

export type StampedEvent = BusEvent & { __infId: string };

export type StoredMessage = {
    info: Message;
    parts: Part[];
};
