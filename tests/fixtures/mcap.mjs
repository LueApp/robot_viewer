import { McapWriter } from '@mcap/core';

const encode = value => new TextEncoder().encode(value);

// Each topic contributes messages independently, including interleaved log times.
export async function mcapFile(topics, options = {}) {
    const parts = [];
    let size = 0n;
    const writer = new McapWriter({ writable: {
        position: () => size,
        write: async data => { parts.push(data.slice()); size += BigInt(data.length); },
    }, ...options });
    await writer.start();
    for (const { topic, encoding = 'json', schema, messages } of topics) {
        const schemaId = schema ? await writer.registerSchema({ ...schema, data: encode(schema.data) }) : 0;
        const channelId = await writer.registerChannel({ topic, messageEncoding: encoding, schemaId, metadata: new Map() });
        for (const [time, payload] of messages) {
            const data = encoding === 'json' ? encode(JSON.stringify(payload)) : payload;
            await writer.addMessage({ channelId, sequence: 0, logTime: time, publishTime: time, data });
        }
    }
    await writer.end();
    return new Blob(parts);
}

export const encoderTopic = { topic: '/encoders', messages: [
    [1000000000n, { feedback: { labels: ['shaft'], degrees: [0] } }],
    [1250000000n, { feedback: { labels: ['shaft'], degrees: [45] } }],
] };
