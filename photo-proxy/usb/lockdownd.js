/**
 * lockdownd 协议实现
 *
 * lockdownd 是 iOS 设备上的守护进程，管理服务访问控制
 * 默认端口：62078
 *
 * 协议格式：
 * - 使用 plist (Property List) 格式进行消息交换
 * - 需要设备配对记录（pairing record）进行认证
 *
 * 参考：
 * - https://www.theiphonewiki.com/wiki/Lockdownd
 * - https://github.com/libimobiledevice/libimobiledevice
 */
import plist from 'plist';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
export class LockdowndClient {
    constructor(usbmuxd, udid) {
        this.socket = null;
        this.connected = false;
        this.messageIdCounter = 0;
        this.pendingRequests = new Map();
        this.dataBuffer = Buffer.alloc(0);
        this.usbmuxd = usbmuxd;
        this.udid = udid;
    }
    /**
     * 连接到 lockdownd 服务
     */
    async connect() {
        console.log(`[LockdowndClient] Connecting to lockdownd for device: ${this.udid}`);
        // 1. 通过 usbmuxd 连接到设备的 62078 端口（lockdownd 默认端口）
        this.socket = await this.usbmuxd.connectToDevice(this.udid, 62078);
        // 等待 socket 连接事件（代理 socket 会立即触发 connect）
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Socket connection timeout'));
            }, 5000);
            if (this.socket.readyState === 'open') {
                clearTimeout(timeout);
                resolve();
            }
            else {
                this.socket.once('connect', () => {
                    clearTimeout(timeout);
                    resolve();
                });
                this.socket.once('error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
            }
        });
        console.log('[LockdowndClient] Socket connected, readyState:', this.socket.readyState);
        // 2. 设置消息处理器
        this.setupMessageHandler();
        // 3. 标记为已连接（在 handshake 之前，因为 handshake 需要检查 connected）
        this.connected = true;
        // 4. 发送握手消息
        await this.handshake();
        console.log('[LockdowndClient] ✅ Connected to lockdownd');
    }
    /**
     * 设置消息处理器
     */
    setupMessageHandler() {
        if (!this.socket)
            return;
        // 只监听 'data' 事件，不要同时监听 'readable'，避免重复处理
        this.socket.on('data', (data) => {
            console.log(`[LockdowndClient] Received ${data.length} bytes of data`);
            this.dataBuffer = Buffer.concat([this.dataBuffer, data]);
            this.processMessages();
        });
        this.socket.on('error', (error) => {
            console.error('[LockdowndClient] Socket error:', error);
            // 清理所有待处理的请求
            for (const [id, pending] of this.pendingRequests.entries()) {
                pending.reject(error);
            }
            this.pendingRequests.clear();
        });
        this.socket.on('close', () => {
            console.log('[LockdowndClient] Socket closed');
            this.connected = false;
            // 清理所有待处理的请求
            for (const [id, pending] of this.pendingRequests.entries()) {
                pending.reject(new Error('Socket closed'));
            }
            this.pendingRequests.clear();
        });
    }
    /**
     * 处理接收到的消息
     */
    processMessages() {
        while (this.dataBuffer.length >= 4) {
            // lockdownd 消息格式：4 字节长度（大端序）+ plist payload
            const length = this.dataBuffer.readUInt32BE(0);
            console.log(`[LockdowndClient] Processing message: declared length=${length}, buffer length=${this.dataBuffer.length}`);
            if (length < 4 || length > 1024 * 1024) {
                // 无效的消息长度，跳过第一个字节
                console.warn(`[LockdowndClient] Invalid message length: ${length}`);
                this.dataBuffer = this.dataBuffer.slice(1);
                continue;
            }
            if (this.dataBuffer.length < length) {
                // 消息不完整，等待更多数据
                console.log(`[LockdowndClient] Message incomplete, waiting for more data (need ${length}, have ${this.dataBuffer.length})`);
                break;
            }
            // 解析 plist
            const plistData = this.dataBuffer.slice(4, length);
            // 调试：打印 plist 数据的前200个字符
            let plistStr = plistData.toString('utf-8');
            const preview = plistStr.substring(0, Math.min(200, plistStr.length));
            console.log(`[LockdowndClient] Plist data preview (first 200 chars):`);
            console.log(`[LockdowndClient] ${preview}`);
            // 尝试多种方法解析 plist
            let message = null;
            // 方法1: 手动解析 XML（使用正则表达式提取关键字段）
            // 这是 fallback 方法，当 plist 包失败时使用
            try {
                // 更宽松的正则表达式，支持各种空白字符
                const messageTypeMatch = plistStr.match(/<key>\s*MessageType\s*<\/key>\s*<string>([^<]+)<\/string>/i);
                const requestIdMatch = plistStr.match(/<key>\s*RequestID\s*<\/key>\s*<integer>(\d+)<\/integer>/i);
                // 也尝试 ID 字段（某些版本可能使用 ID 而不是 RequestID）
                const idMatch = plistStr.match(/<key>\s*ID\s*<\/key>\s*<integer>(\d+)<\/integer>/i);
                const errorMatch = plistStr.match(/<key>\s*Error\s*<\/key>\s*<string>([^<]+)<\/string>/i);
                const portMatch = plistStr.match(/<key>\s*Port\s*<\/key>\s*<integer>(\d+)<\/integer>/i);
                const numberMatch = plistStr.match(/<key>\s*Number\s*<\/key>\s*<integer>(\d+)<\/integer>/i);
                // 调试：打印完整的 plist 字符串，看看实际内容
                console.log(`[LockdowndClient] Full plist string for regex matching:`);
                console.log(`[LockdowndClient] ${plistStr}`);
                if (messageTypeMatch || requestIdMatch || idMatch || errorMatch || portMatch || numberMatch) {
                    message = {};
                    if (messageTypeMatch) {
                        message.MessageType = messageTypeMatch[1].trim();
                        console.log(`[LockdowndClient] Extracted MessageType: ${message.MessageType}`);
                    }
                    if (requestIdMatch) {
                        message.RequestID = parseInt(requestIdMatch[1], 10);
                        console.log(`[LockdowndClient] Extracted RequestID: ${message.RequestID}`);
                    }
                    else if (idMatch) {
                        message.RequestID = parseInt(idMatch[1], 10);
                        message.ID = message.RequestID; // 也设置 ID 字段
                        console.log(`[LockdowndClient] Extracted ID (as RequestID): ${message.RequestID}`);
                    }
                    if (errorMatch) {
                        message.Error = errorMatch[1].trim();
                        console.log(`[LockdowndClient] Extracted Error: ${message.Error}`);
                    }
                    if (portMatch) {
                        message.Port = parseInt(portMatch[1], 10);
                        console.log(`[LockdowndClient] Extracted Port: ${message.Port}`);
                    }
                    if (numberMatch) {
                        message.Number = parseInt(numberMatch[1], 10);
                        console.log(`[LockdowndClient] Extracted Number: ${message.Number}`);
                    }
                    // 提取其他可能的字段
                    const enableSessionSSLMatch = plistStr.match(/<key>\s*EnableSessionSSL\s*<\/key>\s*<(true|false)\/>/i);
                    if (enableSessionSSLMatch) {
                        message.EnableSessionSSL = enableSessionSSLMatch[1] === 'true';
                    }
                    const pairingDialogMatch = plistStr.match(/<key>\s*PairingDialogResponsePending\s*<\/key>\s*<(true|false)\/>/i);
                    if (pairingDialogMatch) {
                        message.PairingDialogResponsePending = pairingDialogMatch[1] === 'true';
                    }
                    console.log(`[LockdowndClient] ✅ Parsed plist manually (method 1: regex extraction):`, JSON.stringify(message, null, 2));
                }
                else {
                    console.warn(`[LockdowndClient] No key fields found in plist string`);
                }
            }
            catch (e) {
                console.error(`[LockdowndClient] Error in manual parsing:`, e);
            }
            // 方法2: 移除 DOCTYPE 声明（支持多行）并使用 plist 包
            if (!message || (Array.isArray(message) && message.length === 0)) {
                try {
                    let cleanedStr = plistStr.replace(/<!DOCTYPE[\s\S]*?>/gi, '');
                    const parsed = plist.parse(cleanedStr);
                    if (parsed && !(Array.isArray(parsed) && parsed.length === 0)) {
                        message = parsed;
                        console.log(`[LockdowndClient] ✅ Parsed plist successfully (method 2: removed DOCTYPE):`, JSON.stringify(message, null, 2));
                    }
                }
                catch (e) {
                    // 方法2失败，继续尝试
                }
            }
            // 方法3: 提取 <plist> 标签之间的内容
            if (!message || (Array.isArray(message) && message.length === 0)) {
                try {
                    const plistMatch = plistStr.match(/<plist[\s\S]*<\/plist>/i);
                    if (plistMatch) {
                        const plistContent = plistMatch[0];
                        const parsed = plist.parse(plistContent);
                        if (parsed && !(Array.isArray(parsed) && parsed.length === 0)) {
                            message = parsed;
                            console.log(`[LockdowndClient] ✅ Parsed plist successfully (method 3: extracted plist tag):`, JSON.stringify(message, null, 2));
                        }
                    }
                }
                catch (e) {
                    // 方法3失败，继续尝试
                }
            }
            // 如果所有方法都失败
            if (!message || (Array.isArray(message) && message.length === 0)) {
                console.error(`[LockdowndClient] ❌ Failed to parse plist with all methods`);
                console.error(`[LockdowndClient] Raw data (hex):`, plistData.toString('hex').substring(0, 200));
                console.error(`[LockdowndClient] Full plist string (first 500 chars):`, plistStr.substring(0, 500));
                this.dataBuffer = this.dataBuffer.slice(length);
                continue;
            }
            this.dataBuffer = this.dataBuffer.slice(length);
            // 处理响应消息
            if (message && (message.MessageType || message.RequestID !== undefined)) {
                this.handleMessage(message);
            }
            else {
                // 可能是异步消息或格式不对
                console.log('[LockdowndClient] Received message without MessageType/RequestID:', message);
                console.log('[LockdowndClient] Message keys:', Object.keys(message || {}));
            }
        }
    }
    /**
     * 处理消息
     */
    handleMessage(message) {
        const messageType = message.MessageType;
        const requestId = message.RequestID || message.ID;
        console.log(`[LockdowndClient] Handling message: MessageType=${messageType}, RequestID=${requestId}`);
        console.log(`[LockdowndClient] Pending requests: ${Array.from(this.pendingRequests.keys()).join(', ')}`);
        const number = message.Number; // 错误代码（0 = 成功，非0 = 错误）
        if (requestId !== undefined) {
            // 有 RequestID，正常匹配
            const pending = this.pendingRequests.get(requestId);
            if (pending) {
                console.log(`[LockdowndClient] Found pending request for RequestID=${requestId}`);
                this.pendingRequests.delete(requestId);
                if (messageType === 'Result' && message.Error) {
                    console.error(`[LockdowndClient] Error response: ${message.Error}`);
                    pending.reject(new Error(message.Error));
                }
                else if (messageType === 'Result' && number !== undefined && number !== 0) {
                    // Number 字段表示错误代码（0 = 成功，非0 = 错误）
                    console.error(`[LockdowndClient] Error response with Number=${number}`);
                    pending.reject(new Error(`lockdownd error: ${number}`));
                }
                else {
                    console.log(`[LockdowndClient] Resolving request ${requestId} with response`);
                    pending.resolve(message);
                }
            }
            else {
                console.warn(`[LockdowndClient] No pending request found for RequestID=${requestId}`);
            }
        }
        else {
            // 没有 RequestID，尝试按顺序匹配第一个 pending request
            // 这在某些 lockdownd 响应中是正常的（特别是错误响应）
            const pendingRequestIds = Array.from(this.pendingRequests.keys()).sort((a, b) => a - b);
            if (pendingRequestIds.length > 0) {
                const firstRequestId = pendingRequestIds[0];
                const pending = this.pendingRequests.get(firstRequestId);
                if (pending) {
                    console.log(`[LockdowndClient] No RequestID in response, matching to first pending request (RequestID=${firstRequestId})`);
                    this.pendingRequests.delete(firstRequestId);
                    if (messageType === 'Result' && message.Error) {
                        console.error(`[LockdowndClient] Error response: ${message.Error}`);
                        pending.reject(new Error(message.Error));
                    }
                    else if (messageType === 'Result' && number !== undefined && number !== 0) {
                        // Number 字段表示错误代码
                        console.error(`[LockdowndClient] Error response with Number=${number}`);
                        pending.reject(new Error(`lockdownd error: ${number}`));
                    }
                    else {
                        console.log(`[LockdowndClient] Resolving request ${firstRequestId} with response (no RequestID in response)`);
                        pending.resolve(message);
                    }
                }
            }
            else {
                console.warn(`[LockdowndClient] Message has no RequestID and no pending requests:`, message);
            }
        }
    }
    /**
     * 发送 plist 消息
     */
    async sendPlistMessage(message, timeout = 10000) {
        if (!this.socket || !this.connected) {
            throw new Error('Not connected to lockdownd');
        }
        const requestId = ++this.messageIdCounter;
        message.RequestID = requestId;
        const plistData = Buffer.from(plist.build(message));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(plistData.length + 4, 0); // 包含长度字段本身
        const buffer = Buffer.concat([length, plistData]);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error('Request timeout'));
            }, timeout);
            this.pendingRequests.set(requestId, {
                resolve: (response) => {
                    clearTimeout(timer);
                    resolve(response);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                }
            });
            // 检查 socket 状态
            if (!this.socket || this.socket.readyState !== 'open') {
                clearTimeout(timer);
                this.pendingRequests.delete(requestId);
                reject(new Error(`Socket not ready, state: ${this.socket?.readyState || 'null'}`));
                return;
            }
            this.socket.write(buffer, (error) => {
                if (error) {
                    clearTimeout(timer);
                    this.pendingRequests.delete(requestId);
                    reject(error);
                }
                else {
                    console.log(`[LockdowndClient] Sent plist message: RequestID=${requestId}, length=${buffer.length}`);
                }
            });
        });
    }
    /**
     * 握手协议
     */
    async handshake() {
        console.log('[LockdowndClient] Starting handshake...');
        // 1. 发送 Hello 消息
        const helloMessage = {
            MessageType: 'Hello',
            ProgName: 'photo-proxy',
            ClientVersionString: '1.0.0'
        };
        try {
            const helloResponse = await this.sendPlistMessage(helloMessage);
            console.log('[LockdowndClient] Hello response:', helloResponse);
            // 2. 检查是否需要配对
            if (helloResponse.EnableSessionSSL || helloResponse.Error === 'PairingDialogResponsePending') {
                // 需要配对，尝试读取配对记录
                const pairRecord = await this.readPairRecord();
                if (pairRecord) {
                    // 发送配对记录
                    // 注意：配对记录的格式可能因 iOS 版本而异
                    // 某些版本需要发送整个 plist 的字典，某些版本需要 base64 编码
                    const pairMessage = {
                        MessageType: 'PairRecord'
                    };
                    // 尝试解析配对记录 plist
                    try {
                        const pairPlist = plist.parse(pairRecord);
                        if (pairPlist && typeof pairPlist === 'object') {
                            // 如果配对记录是 plist 对象，直接使用
                            // lockdownd 可能需要整个字典或特定字段
                            pairMessage.PairRecordData = pairPlist;
                        }
                        else {
                            // 如果解析失败，使用原始字符串
                            pairMessage.PairRecordData = pairRecord;
                        }
                    }
                    catch (error) {
                        // 如果解析失败，使用原始数据
                        console.warn('[LockdowndClient] Failed to parse pair record, using raw data:', error);
                        pairMessage.PairRecordData = pairRecord;
                    }
                    const pairResponse = await this.sendPlistMessage(pairMessage);
                    console.log('[LockdowndClient] Pair response:', pairResponse);
                }
                else {
                    console.warn('[LockdowndClient] ⚠️ No pair record found, device may need to trust this computer');
                    // 继续尝试，某些操作可能不需要配对
                }
            }
            console.log('[LockdowndClient] ✅ Handshake completed');
        }
        catch (error) {
            console.error('[LockdowndClient] ❌ Handshake failed:', error);
            // 不抛出错误，某些设备可能不需要完整的握手
        }
    }
    /**
     * 读取配对记录
     */
    async readPairRecord() {
        try {
            // 配对记录通常存储在：
            // macOS: ~/Library/Preferences/com.apple.iTunes.plist 或
            //        ~/Library/Preferences/com.apple.iPod.plist
            // 或者通过 libimobiledevice: ~/.config/libimobiledevice/
            const homeDir = os.homedir();
            const possiblePaths = [
                path.join(homeDir, '.config', 'libimobiledevice', `${this.udid}.plist`),
                path.join(homeDir, 'Library', 'Preferences', `com.apple.iTunes.${this.udid}.plist`),
                path.join(homeDir, 'Library', 'Preferences', `com.apple.iPod.${this.udid}.plist`)
            ];
            for (const pairPath of possiblePaths) {
                if (fs.existsSync(pairPath)) {
                    console.log(`[LockdowndClient] Found pair record: ${pairPath}`);
                    const pairData = fs.readFileSync(pairPath, 'utf-8');
                    // 配对记录是 plist 格式，直接返回原始数据
                    // lockdownd 可能需要整个 plist 或特定字段
                    // 当前实现返回原始 plist 数据，由调用方决定如何处理
                    return pairData;
                }
            }
            console.log('[LockdowndClient] No pair record found');
            return null;
        }
        catch (error) {
            console.error('[LockdowndClient] Failed to read pair record:', error);
            return null;
        }
    }
    /**
     * 启动服务（如 iOS Companion Service）
     */
    async startService(serviceName) {
        if (!this.connected) {
            throw new Error('Not connected to lockdownd');
        }
        console.log(`[LockdowndClient] Starting service: ${serviceName}`);
        // 发送 StartService 消息
        const startMessage = {
            MessageType: 'StartService',
            Service: serviceName
        };
        try {
            const response = await this.sendPlistMessage(startMessage);
            // 检查错误响应
            if (response.Error) {
                throw new Error(`Failed to start service: ${response.Error}`);
            }
            // 检查 Number 字段（错误代码：0 = 成功，非0 = 错误）
            if (response.Number !== undefined && response.Number !== 0) {
                throw new Error(`Failed to start service: lockdownd error code ${response.Number}`);
            }
            const port = response.Port;
            if (!port) {
                // 如果没有 Port 字段，可能是服务不存在或启动失败
                if (response.Number !== undefined && response.Number !== 0) {
                    throw new Error(`Service ${serviceName} not available (error code: ${response.Number})`);
                }
                throw new Error(`Service port not returned (service may not exist)`);
            }
            console.log(`[LockdowndClient] ✅ Service ${serviceName} started on port ${port}`);
            // 通过 usbmuxd 连接到服务端口
            const serviceSocket = await this.usbmuxd.connectToDevice(this.udid, port);
            return {
                name: serviceName,
                port: port,
                socket: serviceSocket
            };
        }
        catch (error) {
            console.error(`[LockdowndClient] ❌ Failed to start service ${serviceName}:`, error);
            throw error;
        }
    }
    /**
     * 断开连接
     */
    disconnect() {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
            this.connected = false;
            this.dataBuffer = Buffer.alloc(0);
            this.pendingRequests.clear();
            console.log('[LockdowndClient] Disconnected');
        }
    }
    /**
     * 检查是否已连接
     */
    isConnected() {
        return this.connected && this.socket !== null;
    }
}
