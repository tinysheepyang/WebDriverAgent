/**
 * iOS Companion Service 消息协议
 *
 * 协议格式（自定义 framing）：
 * [消息头: 8 字节][JSON 请求/响应][二进制数据（可选）]
 *
 * 消息头格式：
 * - 4 字节：消息类型（uint32，大端序）
 * - 4 字节：JSON 长度（uint32，大端序）
 *
 * 消息类型：
 * - 1: LIST_ASSETS
 * - 2: GET_THUMBNAIL
 * - 3: GET_IMAGE
 * - 4: GET_VIDEO_STREAM
 * - 100: RESPONSE_SUCCESS
 * - 101: RESPONSE_ERROR
 */
export var MessageType;
(function (MessageType) {
    // 请求类型
    MessageType[MessageType["LIST_ASSETS"] = 1] = "LIST_ASSETS";
    MessageType[MessageType["GET_THUMBNAIL"] = 2] = "GET_THUMBNAIL";
    MessageType[MessageType["GET_IMAGE"] = 3] = "GET_IMAGE";
    MessageType[MessageType["GET_VIDEO_STREAM"] = 4] = "GET_VIDEO_STREAM";
    MessageType[MessageType["OPEN_URL"] = 5] = "OPEN_URL";
    MessageType[MessageType["AUTO_LOGIN"] = 6] = "AUTO_LOGIN";
    MessageType[MessageType["HTTP_REQUEST"] = 7] = "HTTP_REQUEST";
    // 响应类型
    MessageType[MessageType["RESPONSE_SUCCESS"] = 100] = "RESPONSE_SUCCESS";
    MessageType[MessageType["RESPONSE_ERROR"] = 101] = "RESPONSE_ERROR";
    // 流式数据
    MessageType[MessageType["STREAM_CHUNK"] = 200] = "STREAM_CHUNK";
    MessageType[MessageType["STREAM_END"] = 201] = "STREAM_END";
})(MessageType || (MessageType = {}));
/**
 * 消息序列化
 */
export class MessageSerializer {
    /**
     * 序列化消息为 Buffer
     */
    static serialize(message) {
        const jsonPayload = JSON.stringify(message.payload);
        const jsonBuffer = Buffer.from(jsonPayload, 'utf-8');
        // 消息头：8 字节
        const header = Buffer.alloc(8);
        header.writeUInt32BE(message.type, 0); // 消息类型（大端序）
        header.writeUInt32BE(jsonBuffer.length, 4); // JSON 长度（大端序）
        // 如果有二进制数据，追加到 JSON 后面
        if (message.binaryData) {
            return Buffer.concat([header, jsonBuffer, message.binaryData]);
        }
        else {
            return Buffer.concat([header, jsonBuffer]);
        }
    }
    /**
     * 反序列化 Buffer 为消息
     */
    static deserialize(buffer) {
        if (buffer.length < 8) {
            throw new Error('Message too short');
        }
        // 读取消息头
        const type = buffer.readUInt32BE(0);
        const jsonLength = buffer.readUInt32BE(4);
        if (buffer.length < 8 + jsonLength) {
            throw new Error('Incomplete message');
        }
        // 读取 JSON payload
        const jsonBuffer = buffer.slice(8, 8 + jsonLength);
        const payload = JSON.parse(jsonBuffer.toString('utf-8'));
        // 读取二进制数据（如果有）
        const binaryData = buffer.length > 8 + jsonLength
            ? buffer.slice(8 + jsonLength)
            : undefined;
        return {
            type,
            payload,
            binaryData
        };
    }
}
