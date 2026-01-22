/**
 * PC Bridge Service - 直接 usbmuxd 连接方案
 *
 * 直接通过 usbmuxd 连接到 iOS 设备上的端口，无需端口转发
 */
import { MessageSerializer, MessageType } from './message.js';
import { Readable } from 'stream';
import { UsbmuxdClient } from '../usb/usbmuxd.js';
export class BridgeServiceUsbmuxd {
    constructor() {
        this.serviceSocket = null;
        this.device = null;
        this.connected = false;
        this.messageIdCounter = 0;
        this.pendingRequests = new Map();
        this.usbmuxd = null;
        this.servicePort = 12345;
    }
    /**
     * 连接到 iOS Companion Service（直接通过 usbmuxd）
     */
    async connect(device) {
        if (this.connected && this.device?.udid === device.udid) {
            return; // 已经连接到同一设备
        }
        await this.disconnect();
        this.device = device;
        const udid = device.udid;
        console.log(`[BridgeServiceUsbmuxd] Connecting to device: ${udid} on port ${this.servicePort}`);
        try {
            // 1. 连接到 usbmuxd
            this.usbmuxd = new UsbmuxdClient();
            await this.usbmuxd.connect();
            console.log('[BridgeServiceUsbmuxd] ✅ Connected to usbmuxd');
            // 2. 直接连接到设备上的端口
            this.serviceSocket = await this.usbmuxd.connectToDevice(udid, this.servicePort);
            console.log(`[BridgeServiceUsbmuxd] ✅ Connected to device port ${this.servicePort}`);
            // 3. 设置消息处理器
            this.setupMessageHandler();
            this.connected = true;
            console.log('[BridgeServiceUsbmuxd] ✅ Connected to iOS Companion Service');
        }
        catch (error) {
            console.error('[BridgeServiceUsbmuxd] ❌ Connection failed:', error);
            await this.disconnect();
            throw error;
        }
    }
    /**
     * 设置消息处理器
     */
    setupMessageHandler() {
        if (!this.serviceSocket)
            return;
        let buffer = Buffer.alloc(0);
        this.serviceSocket.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);
            buffer = Buffer.from(this.processMessages(buffer));
        });
        this.serviceSocket.on('error', (error) => {
            console.error('[BridgeServiceUsbmuxd] Socket error:', error);
            // 清理所有待处理的请求
            for (const [id, pending] of this.pendingRequests.entries()) {
                pending.reject(error);
            }
            this.pendingRequests.clear();
        });
        this.serviceSocket.on('close', () => {
            console.log('[BridgeServiceUsbmuxd] Socket closed');
            this.connected = false;
        });
    }
    /**
     * 处理消息
     */
    processMessages(buffer) {
        // 调试：打印收到的原始数据
        if (buffer.length > 0) {
            const preview = buffer.slice(0, Math.min(100, buffer.length));
            const hexPreview = preview.toString('hex');
            const asciiPreview = preview.toString('ascii', 0, Math.min(100, buffer.length)).replace(/[^\x20-\x7E]/g, '.');
            console.log(`[BridgeServiceUsbmuxd] Received data: length=${buffer.length}, preview:`);
            console.log(`[BridgeServiceUsbmuxd]   Hex: ${hexPreview}`);
            console.log(`[BridgeServiceUsbmuxd]   ASCII: ${asciiPreview}`);
            // 检查是否是 plist XML（可能是错误消息）
            const strPreview = buffer.toString('utf-8', 0, Math.min(100, buffer.length));
            if (strPreview.trim().startsWith('<?xml') || strPreview.trim().startsWith('<plist')) {
                console.error('[BridgeServiceUsbmuxd] ⚠️ Received plist XML instead of binary protocol!');
                console.error('[BridgeServiceUsbmuxd] This might be an error message from iOS system');
                console.error('[BridgeServiceUsbmuxd] Full message:', buffer.toString('utf-8'));
                // 清空缓冲区，避免继续解析错误
                return Buffer.alloc(0);
            }
        }
        while (buffer.length >= 8) {
            // 读取消息头
            const type = buffer.readUInt32BE(0);
            const jsonLength = buffer.readUInt32BE(4);
            console.log(`[BridgeServiceUsbmuxd] Parsing message: type=${type}, jsonLength=${jsonLength}, bufferLength=${buffer.length}`);
            if (buffer.length < 8 + jsonLength) {
                // 消息不完整，等待更多数据
                console.log(`[BridgeServiceUsbmuxd] Incomplete message, waiting for more data (need ${8 + jsonLength}, have ${buffer.length})`);
                return buffer;
            }
            // 解析 JSON
            const jsonBuffer = buffer.slice(8, 8 + jsonLength);
            let binaryData = undefined;
            let messageEnd = 8 + jsonLength;
            // 检查是否有二进制数据
            if (buffer.length > 8 + jsonLength) {
                // 对于 RESPONSE_SUCCESS 或 STREAM_CHUNK，可能有二进制数据
                binaryData = buffer.slice(8 + jsonLength);
                messageEnd = buffer.length;
            }
            try {
                const jsonStr = jsonBuffer.toString('utf-8');
                console.log(`[BridgeServiceUsbmuxd] JSON payload: ${jsonStr}`);
                const payload = JSON.parse(jsonStr);
                const message = {
                    type: type,
                    payload,
                    binaryData
                };
                this.handleMessage(message);
                buffer = buffer.slice(messageEnd);
            }
            catch (error) {
                console.error('[BridgeServiceUsbmuxd] Failed to parse message:', error);
                console.error('[BridgeServiceUsbmuxd] JSON buffer:', jsonBuffer.toString('utf-8'));
                // 跳过第一个字节，继续尝试
                buffer = buffer.slice(1);
            }
        }
        return buffer;
    }
    /**
     * 处理收到的消息
     */
    handleMessage(message) {
        console.log(`[BridgeServiceUsbmuxd] Received message: type=${message.type}, payload keys=${Object.keys(message.payload || {}).join(',')}`);
        const messageId = message.payload?.messageId;
        if (messageId === undefined) {
            console.warn('[BridgeServiceUsbmuxd] Received message without messageId:', message.type);
            return;
        }
        const pending = this.pendingRequests.get(messageId);
        if (!pending) {
            console.warn('[BridgeServiceUsbmuxd] Received message for unknown messageId:', messageId);
            return;
        }
        if (message.type === MessageType.RESPONSE_SUCCESS) {
            const { data } = message.payload;
            console.log(`[BridgeServiceUsbmuxd] ✅ Response success for messageId ${messageId}, hasBinary=${!!message.binaryData}`);
            if (message.binaryData) {
                pending.resolve({ data, binary: message.binaryData });
            }
            else {
                pending.resolve(data);
            }
            this.pendingRequests.delete(messageId);
        }
        else if (message.type === MessageType.RESPONSE_ERROR) {
            const { error } = message.payload;
            console.error(`[BridgeServiceUsbmuxd] ❌ Response error for messageId ${messageId}: ${error}`);
            pending.reject(new Error(error || 'Unknown error'));
            this.pendingRequests.delete(messageId);
        }
        else if (message.type === MessageType.STREAM_CHUNK) {
            console.log(`[BridgeServiceUsbmuxd] Stream chunk for messageId ${messageId}, size=${message.binaryData?.length || 0} bytes`);
            if (pending.stream && message.binaryData) {
                pending.stream.push(message.binaryData);
            }
        }
        else if (message.type === MessageType.STREAM_END) {
            console.log(`[BridgeServiceUsbmuxd] Stream end for messageId ${messageId}`);
            if (pending.stream) {
                pending.stream.push(null);
            }
            this.pendingRequests.delete(messageId);
        }
    }
    /**
     * 发送消息并等待响应
     */
    async sendRequest(type, payload, expectStream = false) {
        if (!this.connected || !this.serviceSocket) {
            throw new Error('Not connected to iOS Companion Service');
        }
        const messageId = ++this.messageIdCounter;
        return new Promise((resolve, reject) => {
            const message = {
                type,
                payload: {
                    messageId,
                    ...payload
                }
            };
            if (expectStream) {
                const stream = new Readable({
                    read() {
                        // 数据通过 handleMessage 推送
                    }
                });
                this.pendingRequests.set(messageId, { resolve, reject, stream });
                resolve(stream);
            }
            else {
                this.pendingRequests.set(messageId, { resolve, reject });
            }
            const buffer = MessageSerializer.serialize(message);
            console.log(`[BridgeServiceUsbmuxd] Sending message: type=${type}, messageId=${messageId}, size=${buffer.length} bytes`);
            // 添加超时处理
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(messageId);
                reject(new Error(`Request timeout for messageId ${messageId}`));
            }, 30000); // 30 秒超时
            // 更新 pending request，添加超时清理
            const pending = this.pendingRequests.get(messageId);
            if (pending) {
                const originalReject = pending.reject;
                pending.reject = (error) => {
                    clearTimeout(timeout);
                    originalReject(error);
                };
                const originalResolve = pending.resolve;
                pending.resolve = (value) => {
                    clearTimeout(timeout);
                    originalResolve(value);
                };
            }
            this.serviceSocket.write(buffer, (error) => {
                if (error) {
                    clearTimeout(timeout);
                    this.pendingRequests.delete(messageId);
                    console.error(`[BridgeServiceUsbmuxd] Failed to send message:`, error);
                    reject(error);
                }
                else {
                    console.log(`[BridgeServiceUsbmuxd] Message sent successfully`);
                }
            });
        });
    }
    /**
     * 获取资源列表
     */
    async listAssets(limit, offset) {
        return this.sendRequest(MessageType.LIST_ASSETS, { limit, offset });
    }
    /**
     * 获取缩略图
     */
    async getThumbnail(assetId, size) {
        const response = await this.sendRequest(MessageType.GET_THUMBNAIL, { assetId, size });
        return response.binary || Buffer.alloc(0);
    }
    /**
     * 获取图片
     */
    async getImage(assetId, quality = 'full', format = 'jpeg') {
        return this.sendRequest(MessageType.GET_IMAGE, { assetId, quality, format }, true);
    }
    /**
     * 获取视频流
     */
    async getVideoStream(assetId) {
        return this.sendRequest(MessageType.GET_VIDEO_STREAM, { assetId }, true);
    }
    /**
     * 断开连接
     */
    async disconnect() {
        if (this.serviceSocket) {
            this.serviceSocket.destroy();
            this.serviceSocket = null;
        }
        if (this.usbmuxd) {
            // UsbmuxdClient 没有 disconnect 方法，但 socket 会被自动清理
            this.usbmuxd = null;
        }
        // 清理所有待处理的请求
        for (const [id, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error('Disconnected'));
        }
        this.pendingRequests.clear();
        this.connected = false;
        this.device = null;
        console.log('[BridgeServiceUsbmuxd] Disconnected');
    }
    /**
     * 检查是否已连接
     */
    isConnected() {
        return this.connected;
    }
}
