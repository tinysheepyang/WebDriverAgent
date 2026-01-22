/**
 * iOS 设备连接管理
 * 使用 usbmuxd + lockdownd 协议
 */
import { spawn } from 'child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export class DeviceManager {
    constructor() {
        this.useLibimobiledevice = false;
        // 获取 go-ios 命令路径
        const appPath = process.env.APP_PATH || path.join(__dirname, '../../');
        this.iosCommandPath = path.join(appPath, 'commands', 'ios');
        // 检查 libimobiledevice 是否可用（优先使用）
        this.checkLibimobiledevice();
    }
    /**
     * 检查 libimobiledevice 是否可用
     */
    checkLibimobiledevice() {
        // 异步检查，不阻塞构造函数
        const proc = spawn('idevice_id', ['-l'], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        proc.on('close', (code) => {
            if (code === 0) {
                this.useLibimobiledevice = true;
                console.log('[DeviceManager] Using libimobiledevice for device detection');
            }
        });
        proc.on('error', () => {
            // libimobiledevice 不可用，使用 go-ios
            this.useLibimobiledevice = false;
        });
    }
    /**
     * 获取连接的 iOS 设备列表
     * 优先使用 libimobiledevice，fallback 到 go-ios
     */
    async getDevices() {
        return new Promise((resolve, reject) => {
            // 方案 1: 使用 libimobiledevice（如果可用）
            if (this.useLibimobiledevice) {
                const proc = spawn('idevice_id', ['-l'], {
                    stdio: ['ignore', 'pipe', 'pipe']
                });
                let stdout = '';
                let stderr = '';
                proc.stdout.on('data', (data) => {
                    stdout += data.toString();
                });
                proc.stderr.on('data', (data) => {
                    stderr += data.toString();
                });
                proc.on('close', (code) => {
                    if (code === 0) {
                        const udids = stdout.trim().split('\n').filter(udid => udid.trim());
                        const devices = udids.map(udid => ({
                            udid: udid.trim(),
                            name: undefined,
                            productType: undefined,
                            iosVersion: undefined
                        }));
                        resolve(devices);
                    }
                    else {
                        // libimobiledevice 失败，fallback 到 go-ios
                        console.warn('[DeviceManager] libimobiledevice failed, falling back to go-ios');
                        this.useLibimobiledevice = false;
                        this.getDevicesWithGoIOS(resolve, reject);
                    }
                });
                proc.on('error', () => {
                    // libimobiledevice 不可用，fallback 到 go-ios
                    this.useLibimobiledevice = false;
                    this.getDevicesWithGoIOS(resolve, reject);
                });
                return;
            }
            // 方案 2: 使用 go-ios
            this.getDevicesWithGoIOS(resolve, reject);
        });
    }
    /**
     * 使用 go-ios 获取设备列表
     */
    getDevicesWithGoIOS(resolve, reject) {
        // 检查命令文件是否存在
        try {
            if (!fs.existsSync(this.iosCommandPath)) {
                console.warn(`[DeviceManager] go-ios 命令不存在: ${this.iosCommandPath}`);
                resolve([]); // 返回空列表，而不是抛出错误
                return;
            }
        }
        catch (error) {
            console.warn(`[DeviceManager] 检查命令文件失败: ${error}`);
            resolve([]);
            return;
        }
        const proc = spawn(this.iosCommandPath, ['list'], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        proc.on('close', (code) => {
            if (code !== 0) {
                // 如果命令失败，返回空列表（表示没有设备或命令不可用）
                console.warn(`[DeviceManager] go-ios list 失败: ${stderr || 'unknown error'}`);
                resolve([]);
                return;
            }
            try {
                // go-ios list 输出格式：{"deviceList":["00008110-001A29940120201E",...]}
                const output = stdout.trim();
                if (!output) {
                    resolve([]);
                    return;
                }
                const data = JSON.parse(output);
                const deviceList = data.deviceList || [];
                if (!Array.isArray(deviceList) || deviceList.length === 0) {
                    resolve([]);
                    return;
                }
                // 将 UDID 列表转换为 IOSDevice 对象
                const devices = deviceList.map((udid) => ({
                    udid: String(udid),
                    name: undefined, // go-ios list 不返回名称，需要额外调用获取
                    iosVersion: undefined,
                    productType: undefined
                }));
                resolve(devices);
            }
            catch (error) {
                console.warn(`[DeviceManager] 解析设备列表失败: ${error}`);
                console.warn(`[DeviceManager] 输出内容: ${stdout}`);
                resolve([]); // 返回空列表，而不是抛出错误
            }
        });
    }
    /**
     * 获取第一个可用设备
     */
    async getFirstDevice() {
        const devices = await this.getDevices();
        return devices.length > 0 ? devices[0] : null;
    }
}
