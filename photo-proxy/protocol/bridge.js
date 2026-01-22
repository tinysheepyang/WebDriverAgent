/**
 * PC Bridge Service
 *
 * 通过 usbmuxd/lockdownd 与 iOS Companion Service 通信
 *
 * 通信流程：
 * 1. 通过 usbmuxd 连接到设备
 * 2. 通过 lockdownd 启动 iOS Companion Service
 * 3. 使用自定义协议进行消息交换
 */
import { UsbmuxdClient } from '../usb/usbmuxd.js';
import { LockdowndClient } from '../usb/lockdownd.js';
import { MessageSerializer, MessageType } from './message.js';
import { Readable } from 'stream';
export class BridgeService {
    constructor() {
        this.usbmuxd = null;
        this.lockdownd = null;
        this.serviceSocket = null;
        this.device = null;
        this.connected = false;
        this.messageIdCounter = 0;
        this.pendingRequests = new Map();
    }
    /**
     * 连接到 iOS Companion Service
     */
    async connect(device) {
        if (this.connected && this.device?.udid === device.udid) {
            return; // 已经连接到同一设备
        }
        await this.disconnect();
        this.device = device;
        const udid = device.udid;
        console.log(`[BridgeService] Connecting to device: ${udid}`);
        // 1. 连接到 usbmuxd
        this.usbmuxd = new UsbmuxdClient();
        await this.usbmuxd.connect();
        console.log('[BridgeService] ✅ Connected to usbmuxd');
        // 2. 连接到 lockdownd
        this.lockdownd = new LockdowndClient(this.usbmuxd, udid);
        await this.lockdownd.connect();
        console.log('[BridgeService] ✅ Connected to lockdownd');
        // 3. 启动 iOS Companion Service
        // 注意：服务名称需要与 iOS 应用中的服务名称匹配
        // 尝试多种服务名称格式，看哪种能被 lockdownd 识别
        const serviceNames = [
            'com.xiaoying.photo-companion', // Bundle ID
            'com.xiaoying.photo-companion.service', // 带 .service 后缀
            'com.apple.photo-companion', // 尝试系统服务格式（可能不会工作）
            'photo-companion' // 简化名称
        ];
        let service = null;
        let lastError = null;
        for (const serviceName of serviceNames) {
            try {
                console.log(`[BridgeService] Trying service name: ${serviceName}`);
                service = await this.lockdownd.startService(serviceName);
                console.log(`[BridgeService] ✅ Service ${serviceName} started on port: ${service.port}`);
                break; // 成功，退出循环
            }
            catch (error) {
                console.warn(`[BridgeService] ⚠️ Failed to start service ${serviceName}:`, error.message);
                lastError = error;
                // 继续尝试下一个服务名称
            }
        }
        if (!service) {
            // 所有服务名称都失败
            console.error('[BridgeService] ❌ All service name attempts failed');
            console.error('[BridgeService] This indicates that the service is not registered with lockdownd');
            console.error('[BridgeService] Possible solutions:');
            console.error('[BridgeService] 1. Use Network Extension (requires Apple approval)');
            console.error('[BridgeService] 2. Use file system communication (AFC service)');
            console.error('[BridgeService] 3. Use Bonjour/mDNS (if device on same network)');
            throw lastError || new Error('Failed to start iOS Companion Service with any service name');
        }
        // 4. 连接到服务
        this.serviceSocket = service.socket;
        this.setupMessageHandler();
        this.connected = true;
        console.log('[BridgeService] ✅ Connected to iOS Companion Service');
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
            // 尝试解析消息
            while (buffer.length >= 8) {
                const jsonLength = buffer.readUInt32BE(4);
                const messageLength = 8 + jsonLength;
                if (buffer.length < messageLength) {
                    // 消息不完整，等待更多数据
                    break;
                }
                try {
                    const message = MessageSerializer.deserialize(buffer.slice(0, messageLength));
                    this.handleMessage(message);
                    buffer = buffer.slice(messageLength);
                }
                catch (error) {
                    console.error('[BridgeService] Failed to deserialize message:', error);
                    buffer = buffer.slice(1); // 跳过第一个字节，尝试重新对齐
                }
            }
        });
        this.serviceSocket.on('error', (error) => {
            console.error('[BridgeService] Socket error:', error);
            this.connected = false;
        });
        this.serviceSocket.on('close', () => {
            console.log('[BridgeService] Socket closed');
            this.connected = false;
        });
    }
    /**
     * 处理收到的消息
     */
    handleMessage(message) {
        const messageId = message.payload?.messageId;
        if (messageId === undefined) {
            console.warn('[BridgeService] Received message without messageId:', message.type);
            return;
        }
        const pending = this.pendingRequests.get(messageId);
        if (!pending) {
            console.warn('[BridgeService] Received message for unknown messageId:', messageId);
            return;
        }
        if (message.type === MessageType.RESPONSE_SUCCESS) {
            const { data } = message.payload;
            if (message.binaryData) {
                // 如果有二进制数据（如缩略图），添加到响应中
                pending.resolve({ data, binary: message.binaryData });
            }
            else {
                pending.resolve(data);
            }
            this.pendingRequests.delete(messageId);
        }
        else if (message.type === MessageType.RESPONSE_ERROR) {
            const { error } = message.payload;
            pending.reject(new Error(error || 'Unknown error'));
            this.pendingRequests.delete(messageId);
        }
        else if (message.type === MessageType.STREAM_CHUNK) {
            // 流式数据块
            if (pending.stream && message.binaryData) {
                pending.stream.push(message.binaryData);
            }
        }
        else if (message.type === MessageType.STREAM_END) {
            // 流结束
            if (pending.stream) {
                pending.stream.push(null); // 结束流
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
                // 创建流
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
            this.serviceSocket.write(buffer, (error) => {
                if (error) {
                    this.pendingRequests.delete(messageId);
                    reject(error);
                }
            });
        });
    }
    /**
     * 获取资源列表
     */
    async listAssets(limit, offset) {
        const request = { limit, offset };
        return this.sendRequest(MessageType.LIST_ASSETS, request);
    }
    /**
     * 获取缩略图
     */
    async getThumbnail(assetId, size) {
        const request = { assetId, size };
        const response = await this.sendRequest(MessageType.GET_THUMBNAIL, request);
        // 响应格式：{ data: {...}, binary: Buffer }
        if (response && response.binary) {
            return response.binary;
        }
        // 如果没有二进制数据，返回空 Buffer
        return Buffer.alloc(0);
    }
    /**
     * 获取原图（流式）
     */
    async getImage(assetId, quality, format) {
        const request = { assetId, quality, format };
        return this.sendRequest(MessageType.GET_IMAGE, request, true);
    }
    /**
     * 获取视频流
     */
    async getVideoStream(assetId) {
        const request = { assetId };
        return this.sendRequest(MessageType.GET_VIDEO_STREAM, request, true);
    }
    /**
     * 打开 URL（通过 WKWebView）
     */
    async openURL(url) {
        const request = { url };
        await this.sendRequest(MessageType.OPEN_URL, request);
    }
    /**
     * 断开连接
     */
    async disconnect() {
        if (this.serviceSocket) {
            this.serviceSocket.destroy();
            this.serviceSocket = null;
        }
        if (this.lockdownd) {
            this.lockdownd.disconnect();
            this.lockdownd = null;
        }
        if (this.usbmuxd) {
            this.usbmuxd.disconnect();
            this.usbmuxd = null;
        }
        this.connected = false;
        this.device = null;
        this.pendingRequests.clear();
        console.log('[BridgeService] Disconnected');
    }
    /**
     * 检查是否已连接
     */
    isConnected() {
        return this.connected && this.serviceSocket !== null;
    }
}
