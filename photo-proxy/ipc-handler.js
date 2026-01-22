/**
 * Photo Proxy IPC Handler
 *
 * 通过 Electron IPC 暴露 PhotosService API
 * 替代 HTTP 服务器
 */
import { ipcMain } from 'electron';
import { PhotosService } from './usb/service.js';
import { URLService } from './usb/url-service.js';
let photosService = null;
let urlService = null;
/**
 * 初始化 IPC Handlers
 */
export function initPhotoProxyIPC() {
    // 创建 PhotosService 实例
    photosService = new PhotosService();
    // 设置设备
    ipcMain.handle('photo-proxy:set-device', async (event, device) => {
        try {
            photosService.setDevice(device);
            return { success: true };
        }
        catch (error) {
            console.error('[PhotoProxy IPC] set-device error:', error);
            return { success: false, error: error.message };
        }
    });
    // 连接
    ipcMain.handle('photo-proxy:connect', async () => {
        try {
            const connected = await photosService.connect();
            return { success: connected };
        }
        catch (error) {
            console.error('[PhotoProxy IPC] connect error:', error);
            return { success: false, error: error.message };
        }
    });
    // 断开连接
    ipcMain.handle('photo-proxy:disconnect', async () => {
        try {
            await photosService.disconnect();
            return { success: true };
        }
        catch (error) {
            console.error('[PhotoProxy IPC] disconnect error:', error);
            return { success: false, error: error.message };
        }
    });
    // 检查服务是否可用
    ipcMain.handle('photo-proxy:is-available', async () => {
        try {
            const available = await photosService.isAvailable();
            return { success: true, available };
        }
        catch (error) {
            console.error('[PhotoProxy IPC] is-available error:', error);
            return { success: false, available: false, error: error.message };
        }
    });
    // 获取资源列表
    ipcMain.handle('photo-proxy:list-assets', async (event, limit, offset) => {
        try {
            const response = await photosService.getAllAssets(limit, offset);
            return { success: true, data: response };
        }
        catch (error) {
            console.error('[PhotoProxy IPC] list-assets error:', error);
            return { success: false, error: error.message };
        }
    });
    // 获取缩略图（返回 base64）
    ipcMain.handle('photo-proxy:get-thumbnail', async (event, assetId, size) => {
        try {
            const thumbnail = await photosService.getThumbnail(assetId, size);
            // 转换为 base64
            const base64 = thumbnail.toString('base64');
            return { success: true, data: base64 };
        }
        catch (error) {
            console.error('[PhotoProxy IPC] get-thumbnail error:', error);
            return { success: false, error: error.message };
        }
    });
    // 获取图片（流式，返回 base64）
    ipcMain.handle('photo-proxy:get-image', async (event, assetId, quality = 'full') => {
        try {
            const stream = await photosService.getImage(assetId, quality);
            // 收集流数据
            const chunks = [];
            return new Promise((resolve, reject) => {
                stream.on('data', (chunk) => {
                    chunks.push(chunk);
                });
                stream.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    // 检测图片格式（通过 magic bytes）
                    let mimeType = 'image/jpeg'; // 默认 JPEG
                    const firstBytes = buffer.slice(0, 12);
                    // HEIC/HEIF 格式检测
                    // HEIC 文件通常以 ftyp box 开头，包含 'heic', 'heif', 'mif1' 等标识
                    if (firstBytes.length >= 12) {
                        const ftypIndex = firstBytes.indexOf(Buffer.from('ftyp'));
                        if (ftypIndex >= 0 && ftypIndex < 8) {
                            // 检查是否包含 HEIC 相关标识
                            const heicIdentifiers = ['heic', 'heif', 'mif1', 'msf1'];
                            const hasHeic = heicIdentifiers.some(id => firstBytes.indexOf(Buffer.from(id), ftypIndex) >= 0);
                            if (hasHeic) {
                                mimeType = 'image/heic';
                                console.warn('[PhotoProxy IPC] ⚠️ 检测到 HEIC 格式，浏览器可能无法显示。建议在 iOS 端转换为 JPEG。');
                            }
                        }
                        // JPEG 格式检测 (FF D8 FF)
                        if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
                            mimeType = 'image/jpeg';
                        }
                        // PNG 格式检测 (89 50 4E 47)
                        else if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
                            mimeType = 'image/png';
                        }
                    }
                    const base64 = buffer.toString('base64');
                    resolve({ success: true, data: base64, mimeType });
                });
                stream.on('error', (error) => {
                    reject({ success: false, error: error.message });
                });
            });
        }
        catch (error) {
            console.error('[PhotoProxy IPC] get-image error:', error);
            return { success: false, error: error.message };
        }
    });
    // 获取视频流（流式，返回 base64）
    ipcMain.handle('photo-proxy:get-video-stream', async (event, assetId) => {
        try {
            const stream = await photosService.getVideoStream(assetId);
            // 收集流数据
            const chunks = [];
            return new Promise((resolve, reject) => {
                stream.on('data', (chunk) => {
                    chunks.push(chunk);
                });
                stream.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    const base64 = buffer.toString('base64');
                    resolve({ success: true, data: base64 });
                });
                stream.on('error', (error) => {
                    reject({ success: false, error: error.message });
                });
            });
        }
        catch (error) {
            console.error('[PhotoProxy IPC] get-video-stream error:', error);
            return { success: false, error: error.message };
        }
    });
    // ========== URL Service IPC Handlers ==========
    // 创建 URLService 实例
    urlService = new URLService();
    // 设置设备（URL Service）
    ipcMain.handle('url-service:set-device', async (event, device) => {
        try {
            urlService.setDevice(device);
            return { success: true };
        }
        catch (error) {
            console.error('[URL Service IPC] set-device error:', error);
            return { success: false, error: error.message };
        }
    });
    // 连接（URL Service）
    ipcMain.handle('url-service:connect', async () => {
        try {
            const connected = await urlService.connect();
            return { success: connected };
        }
        catch (error) {
            console.error('[URL Service IPC] connect error:', error);
            return { success: false, error: error.message };
        }
    });
    // 断开连接（URL Service）
    ipcMain.handle('url-service:disconnect', async () => {
        try {
            await urlService.disconnect();
            return { success: true };
        }
        catch (error) {
            console.error('[URL Service IPC] disconnect error:', error);
            return { success: false, error: error.message };
        }
    });
    // 打开 URL
    ipcMain.handle('url-service:open-url', async (event, url) => {
        try {
            await urlService.openURL(url);
            return { success: true };
        }
        catch (error) {
            console.error('[URL Service IPC] open-url error:', error);
            return { success: false, error: error.message };
        }
    });
    // 设备侧 HTTP 请求
    ipcMain.handle('url-service:http-request', async (event, options) => {
        try {
            const resp = await urlService.httpRequest(options);
            return { success: true, data: resp };
        }
        catch (error) {
            console.error('[URL Service IPC] http-request error:', error);
            return { success: false, error: error.message };
        }
    });
    console.log('[PhotoProxy IPC] ✅ IPC handlers registered');
}
/**
 * 清理 IPC Handlers
 */
export function cleanupPhotoProxyIPC() {
    if (photosService) {
        photosService.disconnect().catch(console.error);
        photosService = null;
    }
    if (urlService) {
        urlService.disconnect().catch(console.error);
        urlService = null;
    }
}
